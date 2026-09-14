import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { buildIndex, applyChanges, freshness, ask, callersDetailed, findTextDetailed, serializeArtifact } from "../../src/index.js";
import { artifactPathFor, saveArtifact } from "../../src/index/serialize.js";
import { formatAsk, formatCallersDetailed, formatFindTextResult, formatIndexDiagnostics } from "../../src/query/format.js";
import { boundText } from "../../src/query/budget.js";
import type { OsnovaIndex } from "../../src/types.js";
import { manifestFingerprint, parseManifest, validateRelativePath } from "./manifest.js";
import type { BenchmarkCase, BenchmarkManifest } from "./manifest.js";
import { percentile, scoreRanking, scoreSet } from "./metrics.js";

const execute = promisify(execFile);

export interface CaseMeasurement {
  id: string;
  kind: BenchmarkCase["kind"];
  split: BenchmarkCase["split"];
  status: "measured" | "invalid" | "error";
  expected: readonly string[];
  actual: string[];
  ranking: ReturnType<typeof scoreRanking> | null;
  set: ReturnType<typeof scoreSet> | null;
  elapsedMs: number | null;
  responseCodeUnits: number | null;
  responseBytes: number | null;
  responseClipped: boolean | null;
  response: string | null;
  unresolvedEdges: number | null;
  error: string | null;
}

interface Distribution {
  samples: number[];
  p50: number | null;
  p95: number | null;
}

export interface BenchmarkReport {
  schemaVersion: 1;
  corpus: string;
  manifestFingerprint: string;
  snapshotFingerprint: string | null;
  isolation: "in-process" | "fresh-process";
  scoringScope: "structured-query";
  status: "completed" | "failed";
  index: { files: number; symbols: number; edges: number } | null;
  environment: { node: string; platform: string; arch: string };
  cases: CaseMeasurement[];
  summary: { caseCount: number; errorCount: number; meanRecallAt5: number | null; meanReciprocalRankAt5: number | null; callerPrecision: number | null; callerRecall: number | null; searchPrecision: number | null; searchRecall: number | null };
  performance: null | {
    firstBuildMs: number;
    noChangeRefreshMs: Distribution;
    editedRefreshMs: Distribution;
    serializedArtifactBytes: number;
    storedArtifactBytes: number;
    workerPeakRssBytes: number | null;
    incrementalEqualsFull: boolean;
  };
  analysisDiagnostics: readonly unknown[];
  unmeasured: { taskSuccess: null; contextTokens: null; agentToolCalls: null; packageBytes: null };
  errors: string[];
}

async function checkoutState(root: string, revision: string): Promise<void> {
  const git = (args: string[]) => execute("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 });
  const head = await git(["rev-parse", "HEAD"]);
  if (head.stdout.trim() !== revision) throw new Error("checkout revision mismatch");
  const state = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (state.stdout.length > 0) throw new Error("checkout must be clean, including untracked files");
}

async function snapshot(manifest: BenchmarkManifest, workspace?: string): Promise<Map<string, Buffer>> {
  if (manifest.source.kind === "inline") {
    return new Map(Object.entries(manifest.source.files).map(([file, text]) => [file, Buffer.from(text)]));
  }
  if (workspace === undefined) throw new Error("workspace required for a checkout corpus");
  await checkoutState(workspace, manifest.source.revision);
  const { stdout } = await execute("git", ["-c", "core.fsmonitor=false", "-C", workspace, "ls-files", "-z"], {
    timeout: 30_000, maxBuffer: 10 * 1024 * 1024,
  });
  const paths = stdout.split("\0").filter(Boolean);
  const files = new Map<string, Buffer>();
  for (const relative of paths) {
    validateRelativePath(relative);
    const absolute = path.join(workspace, relative);
    const stat = await fs.lstat(absolute);
    if (!stat.isFile()) throw new Error(`snapshot requires regular files: ${relative}`);
    files.set(relative, await fs.readFile(absolute));
  }
  await checkoutState(workspace, manifest.source.revision);
  return files;
}

function emptyMeasurement(item: BenchmarkCase): CaseMeasurement {
  return {
    id: item.id, kind: item.kind, split: item.split, status: "measured", expected: item.expected, actual: [],
    ranking: null, set: null, elapsedMs: null, responseCodeUnits: null, responseBytes: null,
    responseClipped: null, response: null, unresolvedEdges: null, error: null,
  };
}

function evaluate(index: OsnovaIndex, item: BenchmarkCase, sources: ReadonlyMap<string, Buffer>): CaseMeasurement {
  const result = emptyMeasurement(item);
  for (const anchor of item.anchors) {
    if (!sources.get(anchor.file)?.toString("utf8").includes(anchor.text)) {
      return { ...result, status: "invalid", error: `source anchor mismatch: ${anchor.file}` };
    }
  }
  const start = performance.now();
  try {
    let text: string;
    if (item.kind === "ask") {
      const answer = ask(index, item.question, { in: item.in, limit: 5 });
      result.actual = answer.hits.map((hit) => hit.symbol?.qualifiedName ?? `@${hit.file}:${hit.line}`);
      result.ranking = scoreRanking(result.actual, item.expected, 5);
      text = formatAsk(answer);
    } else if (item.kind === "callers") {
      const answer = callersDetailed(index, item.symbol, { direction: item.direction, depth: item.depth });
      if (answer.status === "ambiguous") throw new Error(`ambiguous query target: ${answer.candidates.map((symbol) => symbol.qualifiedName).join(", ")}`);
      result.actual = [...new Set(answer.hits.filter((hit) => hit.kind === "calls")
        .map((hit) => hit.qualifiedName || `${hit.edge.fromFile}#<module>`))];
      result.unresolvedEdges = answer.unresolved.length;
      result.set = scoreSet(result.actual, item.expected);
      text = formatCallersDetailed(answer);
    } else {
      const answer = findTextDetailed(index, item.pattern, { fixed: item.fixed, in: item.in });
      result.actual = answer.groups.flatMap((group) => group.matches.map((match) => `${group.file}:${match.line}:${match.col}`));
      result.set = scoreSet(result.actual, item.expected);
      text = formatFindTextResult(answer);
    }
    const full = [formatIndexDiagnostics(index), text].filter(Boolean).join("\n");
    result.response = boundText(full);
    result.responseCodeUnits = result.response.length;
    result.responseBytes = Buffer.byteLength(result.response);
    result.responseClipped = result.response.length < full.length;
  } catch (error) {
    result.status = "error";
    result.error = error instanceof Error ? error.message : String(error);
  }
  result.elapsedMs = performance.now() - start;
  return result;
}

function summarize(cases: readonly CaseMeasurement[]): BenchmarkReport["summary"] {
  const average = (kind: BenchmarkCase["kind"], field: "recall" | "precision" | "reciprocalRank"): number | null => {
    const group = cases.filter((item) => item.kind === kind);
    if (group.length === 0 || group.some((item) => item.status === "invalid")) return null;
    return group.reduce((sum, item) => sum + (item.status !== "measured" ? 0
      : field === "reciprocalRank" ? item.ranking?.reciprocalRank ?? 0
        : kind === "ask" ? item.ranking?.recall ?? 0 : item.set?.[field] ?? 0), 0) / group.length;
  };
  return {
    caseCount: cases.length, errorCount: cases.filter((item) => item.status !== "measured").length,
    meanRecallAt5: average("ask", "recall"), meanReciprocalRankAt5: average("ask", "reciprocalRank"),
    callerPrecision: average("callers", "precision"), callerRecall: average("callers", "recall"),
    searchPrecision: average("findText", "precision"), searchRecall: average("findText", "recall"),
  };
}

function distribution(samples: number[]): Distribution {
  return { samples, p50: percentile(samples, 50), p95: percentile(samples, 95) };
}

export async function runBenchmark(
  input: BenchmarkManifest,
  options: { samples: number; split: "development" | "evaluation"; workspace?: string | undefined; temporaryRoot?: string | undefined },
): Promise<BenchmarkReport> {
  if (!Number.isSafeInteger(options.samples) || options.samples < 1 || options.samples > 100) {
    throw new RangeError("benchmark samples must be an integer from 1 to 100");
  }
  if (options.split !== "development" && options.split !== "evaluation") throw new Error("invalid benchmark split");
  const manifest = parseManifest(input);
  const selected = manifest.cases.filter((item) => item.split === options.split);
  if (selected.length === 0) throw new Error("no cases in selected split");
  const report: BenchmarkReport = {
    schemaVersion: 1, corpus: manifest.id, manifestFingerprint: manifestFingerprint(manifest), snapshotFingerprint: null,
    isolation: "in-process", scoringScope: "structured-query", status: "completed",
    index: null,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    cases: selected.map((item) => ({ ...emptyMeasurement(item), status: "error", error: "not run: benchmark setup or indexing failed" })),
    summary: summarize([]), performance: null, analysisDiagnostics: [],
    unmeasured: { taskSuccess: null, contextTokens: null, agentToolCalls: null, packageBytes: null }, errors: [],
  };
  const temporary = await fs.mkdtemp(path.join(options.temporaryRoot ?? os.tmpdir(), "osnova-benchmark-"));
  try {
    const sources = await snapshot(manifest, options.workspace);
    const hash = createHash("sha256");
    const workspace = path.join(temporary, "workspace");
    const cacheDir = path.join(temporary, "cache");
    for (const relative of [...sources.keys()].sort()) {
      const content = sources.get(relative);
      if (content === undefined) throw new Error("missing snapshot file");
      hash.update(JSON.stringify([relative, createHash("sha256").update(content).digest("hex")]));
      await fs.mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
      await fs.writeFile(path.join(workspace, relative), content);
    }
    report.snapshotFingerprint = hash.digest("hex");
    const original = sources.get(manifest.edit.file);
    if (original === undefined) throw new Error("edit file missing from snapshot");
    const start = performance.now();
    let index = await buildIndex(workspace, { cacheDir });
    const firstBuildMs = performance.now() - start;
    report.index = { files: index.files.size, symbols: index.symbols.size, edges: index.edges.length };
    report.analysisDiagnostics = index.diagnostics ?? [];
    report.cases = selected.map((item) => evaluate(index, item, sources));
    const serializedArtifactBytes = serializeArtifact(index).length;
    const artifactPath = await artifactPathFor(workspace, cacheDir);
    if (artifactPath === undefined) throw new Error("artifact was not saved");
    const storedArtifactBytes = (await fs.stat(artifactPath)).size;
    const noChange: number[] = [];
    const edited: number[] = [];
    let equal = true;
    for (let sample = 0; sample < options.samples; sample += 1) {
      const unchangedStart = performance.now();
      const unchanged = await freshness(index, workspace);
      noChange.push(performance.now() - unchangedStart);
      if (unchanged.added.length + unchanged.changed.length + unchanged.deleted.length !== 0) throw new Error("unexpected no-change drift");
      const editPath = path.join(workspace, manifest.edit.file);
      await fs.writeFile(editPath, Buffer.concat([original, Buffer.from(manifest.edit.append)]));
      const changedStart = performance.now();
      const delta = await freshness(index, workspace);
      if (!delta.changed.includes(manifest.edit.file)) throw new Error("freshness missed the benchmark edit");
      index = await applyChanges(index, workspace, [...delta.added, ...delta.changed, ...delta.deleted]);
      await saveArtifact(index, cacheDir);
      edited.push(performance.now() - changedStart);
      const full = await buildIndex(workspace, { cacheDir });
      equal = equal && serializeArtifact(index).equals(serializeArtifact(full));
      await fs.writeFile(editPath, original);
      index = await applyChanges(index, workspace, [manifest.edit.file]);
      await saveArtifact(index, cacheDir);
    }
    const peak = process.resourceUsage().maxRSS * 1024;
    report.performance = {
      firstBuildMs, noChangeRefreshMs: distribution(noChange), editedRefreshMs: distribution(edited),
      serializedArtifactBytes, storedArtifactBytes, workerPeakRssBytes: peak > 0 ? peak : null,
      incrementalEqualsFull: equal,
    };
    if (!equal) report.errors.push("incremental/full mismatch");
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  report.summary = summarize(report.cases);
  if (report.errors.length > 0 || report.summary.errorCount > 0) report.status = "failed";
  return report;
}

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { applyChanges, buildIndex, freshness, loadIndex, scanFiles, serializeArtifact } from "../../src/index.js";
import { artifactPathFor, saveArtifact } from "../../src/index/serialize.js";
import { extractWorkerCount } from "../../src/index/extractPool.js";
import { createOsnovaMcpServer } from "../../src/mcp/server.js";
import type { OsnovaIndex } from "../../src/types.js";
import { manifestFingerprint, parseManifest } from "./manifest.js";
import type { BenchmarkManifest } from "./manifest.js";
import { snapshot } from "./runner.js";
import { childPids, describeSamples, payloadShape, readProcMemory, resetPeakMemory } from "./mcp-measure.js";
import type { PayloadShape, ProcMemory, SampleSummary } from "./mcp-measure.js";

// Measures what pnpm benchmark and scripts/perf.mjs cannot: MCP cold start, warm tool latency and resident
// memory, plus first builds in separate processes and a refresh breakdown on the same snapshot.
// In-process phases run this file's TypeScript sources through tsx; MCP processes run the built dist/bin.js.

export const mcpToolNames = [
  "osnova_ground", "osnova_thread", "osnova_outline", "osnova_warp", "osnova_groundwork",
  "osnova_footing", "osnova_settle", "osnova_plumb", "osnova_tests", "osnova_unreferenced",
] as const;
export type McpToolName = typeof mcpToolNames[number];

export interface McpQuery {
  id: string;
  tool: McpToolName;
  arguments: Record<string, unknown>;
  size: "small" | "large";
  expectEmpty: boolean;
  note?: string | undefined;
}

export interface WorkloadOptions {
  manifest: BenchmarkManifest;
  workspace?: string | undefined;
  queries: readonly McpQuery[];
  samples: number;
  warmups: number;
  coldSamples: number;
  buildSamples: number;
  editSamples: number;
  settleMs: number;
  bin: string;
  temporaryRoot?: string | undefined;
  log?: ((line: string) => void) | undefined;
}

export interface BuildSample {
  processWallMs: number;
  startupMs: number;
  buildMs: number;
  serializeMs: number;
  saveMs: number;
  serializedBytes: number;
  serializedSha256: string;
  artifactBytes: number;
  artifactSha256: string;
  files: number;
  symbols: number;
  edges: number;
  extractWorkers: number;
  diagnosticCount: number;
  diagnosticsByCode: Record<string, number>;
  maxRssKiB: number;
}

export interface EditSample {
  incrementalEqualsFull: boolean;
  revertedEqualsBaseline: boolean;
  editedSha256: string;
}

export interface ColdStartSample {
  readyMs: number;
  firstQueryMs: number;
  firstQueryCallMs: number;
  firstQueryError: string | null;
  memoryAtFirstQuery: ProcMemory;
  artifactSha256: string | null;
  stderr: string;
}

export interface QueryMeasurement {
  id: string;
  tool: McpToolName;
  arguments: Record<string, unknown>;
  size: "small" | "large";
  expectEmpty: boolean;
  note: string | null;
  latencyMs: SampleSummary;
  warmupMs: number[];
  payload: PayloadShape | null;
  responseSha256: string | null;
  preview: string | null;
  response: string | null;
  omissionCounts: OmissionCount[] | null;
  stableResponse: boolean;
  excludedRefreshSamples: number;
  errors: string[];
}

export interface OmissionCount {
  line: number;
  text: string;
  counts: number[];
}

// Every answer line that reports something left out (omitted, not listed, more sites, output clipping), kept whole
// with its 1-based line number, so no count depends on the preview length. counts are the line's standalone integers;
// a location such as a.ts:12,15 is not one, and the text keeps what each count measures.
export function omissionCounts(text: string): OmissionCount[] {
  const found: OmissionCount[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (!/\bomitted\b|\bnot listed\b|\bmore sites\b|\boutput truncated\b/i.test(line)) continue;
    found.push({ line: i + 1, text: line, counts: [...line.matchAll(/(?<=^|[\s+(])\d+(?=$|[\s;,)])/g)].map((match) => Number(match[0])) });
  }
  return found;
}

export interface WarmMode {
  description: string;
  queries: QueryMeasurement[];
}

export interface WorkloadReport {
  schemaVersion: 1;
  workload: string;
  status: "completed" | "failed";
  errors: string[];
  manifestFingerprint: string;
  sourceRevision: string | null;
  snapshotFingerprint: string | null;
  snapshotFiles: number;
  snapshotExclusions: { declared: readonly string[]; files: readonly string[] };
  execution: { inProcess: "tsx-source"; mcpServer: string; node: string; platform: string; arch: string; settings: Record<string, number> };
  hostStart: ReturnType<typeof hostFacts>;
  hostEnd: ReturnType<typeof hostFacts> | null;
  builds: BuildSample[];
  refresh: {
    scanMs: SampleSummary;
    fullHashFreshnessMs: SampleSummary;
    noChangeMemory: SampleSummary;
    loadIndexMs: SampleSummary;
    serializeMs: SampleSummary;
    saveArtifactMs: SampleSummary;
    editedMs: SampleSummary;
    edited: EditSample[];
    editedDecomposedMs: { scan: SampleSummary; fullHashFreshness: SampleSummary; applyChanges: SampleSummary; saveArtifact: SampleSummary; total: SampleSummary };
    editedDecomposed: EditSample[];
    repeatedSerializeIdentical: boolean | null;
  };
  mcp: {
    processVersionMs: SampleSummary;
    coldBuild: ColdStartSample[];
    coldPersisted: ColdStartSample[];
    priming: ColdStartSample | null;
    listToolsMs: SampleSummary;
    warmStdio: WarmMode;
    warmInProcess: WarmMode;
    memory: {
      pid: number | null;
      scope: string;
      idle: ProcMemory;
      idleAfterQueries: ProcMemory;
      peakResetApplied: boolean;
      peakDuringQueryKiB: number | null;
      sampledMaxRssKiB: number | null;
      rssPollSamples: number;
      childPidsSeen: number[];
    };
  };
}

const repository = fileURLToPath(new URL("../../", import.meta.url));
const harnessFile = fileURLToPath(import.meta.url);

function hostFacts() {
  return {
    platform: process.platform, release: os.release(), arch: process.arch, node: process.version,
    cpuModel: os.cpus()[0]?.model ?? null, logicalCpus: os.availableParallelism(),
    totalMemMiB: Math.round(os.totalmem() / 1_048_576), freeMemMiB: Math.round(os.freemem() / 1_048_576),
    loadavg: os.loadavg(),
  };
}

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function timed<T>(action: () => Promise<T> | T): Promise<[T, number]> {
  const start = performance.now();
  const value = await action();
  return [value, performance.now() - start];
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== "OSNOVA_CACHE_DIR") env[key] = value;
  // A fresh cache directory has no siblings to seed from; turning seeding off makes every cold build a real build.
  env.OSNOVA_CACHE_SEED = "off";
  return env;
}

async function storedArtifact(root: string, cacheDir: string): Promise<{ sha: string; bytes: number } | null> {
  const file = await artifactPathFor(root, cacheDir);
  if (file === undefined) return null;
  const content = await fs.readFile(file);
  return { sha: sha256(content), bytes: content.length };
}

function diagnosticCounts(index: OsnovaIndex): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of index.diagnostics ?? []) counts[`${item.phase}/${item.code}`] = (counts[`${item.phase}/${item.code}`] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export async function measureBuild(
  workspace: string, cacheDir: string, peakRssKiB: () => number = () => process.resourceUsage().maxRSS,
): Promise<Omit<BuildSample, "processWallMs">> {
  const startupMs = performance.now();
  const [index, buildMs] = await timed(() => buildIndex(workspace, { cacheDir }));
  // Read before serializing, saving and rereading the artifact, which would otherwise count toward the build's peak.
  const maxRssKiB = peakRssKiB();
  const [bytes, serializeMs] = await timed(() => serializeArtifact(index));
  const canonicalCache = await fs.realpath(cacheDir);
  const [, saveMs] = await timed(() => saveArtifact(index, canonicalCache));
  const stored = await storedArtifact(index.root, canonicalCache);
  if (stored === null) throw new Error("build child: artifact was not saved");
  return {
    startupMs, buildMs, serializeMs, saveMs, serializedBytes: bytes.length, serializedSha256: sha256(bytes),
    artifactBytes: stored.bytes, artifactSha256: stored.sha, files: index.files.size, symbols: index.symbols.size,
    edges: index.edges.length, extractWorkers: extractWorkerCount(index.files.size), diagnosticCount: (index.diagnostics ?? []).length,
    diagnosticsByCode: diagnosticCounts(index), maxRssKiB,
  };
}

async function buildChild(workspace: string, cacheDir: string): Promise<void> {
  process.stdout.write(`${JSON.stringify(await measureBuild(workspace, cacheDir))}\n`);
}

function runBuildChild(workspace: string, cacheDir: string): Promise<BuildSample> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(process.execPath, ["--import", "tsx", harnessFile, "--build-child", "--workspace", workspace, "--cache-dir", cacheDir], {
      cwd: repository, env: childEnv(), stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      const processWallMs = performance.now() - start;
      if (code !== 0) { reject(new Error(`build child exited ${code}: ${stderr.slice(0, 2_000)}`)); return; }
      try {
        resolve({ processWallMs, ...(JSON.parse(stdout) as Omit<BuildSample, "processWallMs">) });
      } catch (error) {
        reject(new Error(`build child output: ${message(error)}`));
      }
    });
  });
}

function runProcess(args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(process.execPath, [...args], { cwd: repository, env: childEnv(), stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(performance.now() - start) : reject(new Error(`${args.join(" ")} exited ${code}`))));
  });
}

interface CallResult { ms: number; text: string; error: string | null }

async function call(client: Client, query: McpQuery): Promise<CallResult> {
  const start = performance.now();
  try {
    const result = await client.callTool({ name: query.tool, arguments: query.arguments }, undefined, { timeout: 300_000 });
    const ms = performance.now() - start;
    const content = (result as { content?: readonly ContentBlock[] }).content ?? [];
    const text = content.map((block) => (block.type === "text" ? block.text : "")).join("");
    return { ms, text, error: result.isError === true ? `tool error: ${text.slice(0, 500)}` : null };
  } catch (error) {
    return { ms: performance.now() - start, text: "", error: message(error) };
  }
}

interface StdioSession { client: Client; transport: StdioClientTransport; start: number; readyMs: number; pid: number | null; stderr: () => string }

async function launch(bin: string, workspace: string, cacheDir: string): Promise<StdioSession> {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [bin, "mcp", "--workspace", workspace, "--cache-dir", cacheDir],
    env: childEnv(), stderr: "pipe", cwd: workspace,
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const client = new Client({ name: "osnova-bench", version: "0.0.0" });
  const start = performance.now();
  await client.connect(transport, { timeout: 300_000 });
  return { client, transport, start, readyMs: performance.now() - start, pid: transport.pid, stderr: () => stderr };
}

async function coldStart(bin: string, workspace: string, cacheDir: string, first: McpQuery): Promise<ColdStartSample> {
  const session = await launch(bin, workspace, cacheDir);
  let sample: ColdStartSample;
  try {
    const result = await call(session.client, first);
    const firstQueryMs = performance.now() - session.start;
    const memoryAtFirstQuery = session.pid === null ? { rssKiB: null, hwmKiB: null, threads: null } : await readProcMemory(session.pid);
    sample = { readyMs: session.readyMs, firstQueryMs, firstQueryCallMs: result.ms, firstQueryError: result.error, memoryAtFirstQuery, artifactSha256: null, stderr: "" };
  } finally {
    await session.client.close();
  }
  sample.stderr = session.stderr().slice(0, 4_000);
  return sample;
}

function emptyMeasurement(query: McpQuery): QueryMeasurement {
  return {
    id: query.id, tool: query.tool, arguments: query.arguments, size: query.size, expectEmpty: query.expectEmpty, note: query.note ?? null,
    latencyMs: describeSamples([]), warmupMs: [], payload: null, responseSha256: null, preview: null, response: null, omissionCounts: null, stableResponse: true,
    excludedRefreshSamples: 0, errors: [],
  };
}

// Round-robin over the queries, so a slow drift in the machine spreads over every query rather than one.
// A sample whose call triggered an index refresh (seen through refreshed()) is retried and counted, never kept.
async function measureQueries(
  client: Client, queries: readonly McpQuery[], samples: number, warmups: number, previewCodeUnits: number, refreshes?: () => number,
): Promise<QueryMeasurement[]> {
  const results = queries.map(emptyMeasurement);
  const latencies = queries.map((): number[] => []);
  const hashes = queries.map(() => new Set<string>());
  for (let round = 0; round < warmups; round += 1) {
    for (const [i, query] of queries.entries()) {
      const outcome = await call(client, query);
      results[i]?.warmupMs.push(outcome.ms);
      if (outcome.error !== null) results[i]?.errors.push(`warmup: ${outcome.error}`);
    }
  }
  for (let round = 0; round < samples; round += 1) {
    for (const [i, query] of queries.entries()) {
      const result = results[i];
      if (result === undefined) continue;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const before = refreshes?.();
        const outcome = await call(client, query);
        if (refreshes !== undefined && refreshes() !== before) { result.excludedRefreshSamples += 1; continue; }
        latencies[i]?.push(outcome.ms);
        if (outcome.error !== null) result.errors.push(outcome.error);
        const hash = sha256(outcome.text);
        hashes[i]?.add(hash);
        if (result.payload === null) {
          result.payload = payloadShape(outcome.text);
          result.responseSha256 = hash;
          result.omissionCounts = omissionCounts(outcome.text);
          // Only the mode that keeps a preview keeps the full answer, so the report holds one copy of each answer.
          result.preview = previewCodeUnits > 0 ? outcome.text.slice(0, previewCodeUnits) : null;
          result.response = previewCodeUnits > 0 ? outcome.text : null;
        }
        break;
      }
    }
  }
  for (const [i, result] of results.entries()) {
    result.latencyMs = describeSamples(latencies[i] ?? []);
    result.stableResponse = (hashes[i]?.size ?? 0) <= 1;
    if (result.latencyMs.count < samples) result.errors.push(`only ${result.latencyMs.count} of ${samples} samples avoided an index refresh`);
  }
  return results;
}

async function writeSnapshot(manifest: BenchmarkManifest, workspace: string | undefined, target: string) {
  const { files, excluded } = await snapshot(manifest, workspace);
  const hash = createHash("sha256");
  for (const relative of [...files.keys()].sort()) {
    const content = files.get(relative);
    if (content === undefined) throw new Error("missing snapshot file");
    hash.update(JSON.stringify([relative, sha256(content)]));
    await fs.mkdir(path.dirname(path.join(target, relative)), { recursive: true });
    await fs.writeFile(path.join(target, relative), content);
  }
  return { files, excluded, fingerprint: hash.digest("hex") };
}

async function measureRefresh(
  options: WorkloadOptions, workspace: string, temporary: string, original: Buffer, report: WorkloadReport,
): Promise<void> {
  // Refreshes go through the MCP server's own refresh(), the path every tool call takes. Calling refreshWorkspace
  // here directly would also add call edges to it, and test/docs-readme-warp.test.ts holds the README to that count.
  const server = createOsnovaMcpServer(workspace, { cacheDir: path.join(temporary, "cache-refresh") });
  try {
    await refreshPhases(options, workspace, temporary, original, server.refresh, report);
  } finally {
    await server.close();
  }
}

async function refreshPhases(
  options: WorkloadOptions, workspace: string, temporary: string, original: Buffer,
  refresh: () => Promise<OsnovaIndex>, report: WorkloadReport,
): Promise<void> {
  const { samples, editSamples, manifest } = options;
  const cacheDir = path.join(temporary, "cache-refresh");
  const editPath = path.join(workspace, manifest.edit.file);
  const edited = Buffer.concat([original, Buffer.from(manifest.edit.append)]);
  let index = await refresh();
  const collect = async (action: () => Promise<unknown> | unknown, count: number): Promise<SampleSummary> => {
    const values: number[] = [];
    for (let i = 0; i < count; i += 1) values.push((await timed(action))[1]);
    return describeSamples(values);
  };
  report.refresh.scanMs = await collect(() => scanFiles(workspace), samples);
  report.refresh.fullHashFreshnessMs = await collect(async () => {
    const found = await freshness(index, workspace);
    if (found.added.length + found.changed.length + found.deleted.length > 0) throw new Error("unexpected no-change drift");
  }, samples);
  report.refresh.noChangeMemory = await collect(refresh, samples);
  report.refresh.loadIndexMs = await collect(() => loadIndex(workspace, { cacheDir }), samples);
  const baseline = serializeArtifact(index);
  const serialized: Buffer[] = [];
  report.refresh.serializeMs = await collect(() => { serialized.push(serializeArtifact(index)); }, 5);
  report.refresh.repeatedSerializeIdentical = serialized.every((bytes) => bytes.equals(baseline));
  const canonicalCache = await fs.realpath(cacheDir);
  report.refresh.saveArtifactMs = await collect(() => saveArtifact(index, canonicalCache), 5);
  index = await refresh();

  const compareFull = async (incremental: OsnovaIndex, sample: number, kind: string): Promise<{ equal: boolean; sha: string }> => {
    const fullCache = path.join(temporary, `cache-full-${kind}-${sample}`);
    const full = await buildIndex(workspace, { cacheDir: fullCache });
    const bytes = serializeArtifact(incremental);
    const equal = bytes.equals(serializeArtifact(full));
    await fs.rm(fullCache, { recursive: true, force: true });
    return { equal, sha: sha256(bytes) };
  };

  const editedMs: number[] = [];
  for (let sample = 0; sample < editSamples; sample += 1) {
    await fs.writeFile(editPath, edited);
    const [next, ms] = await timed(refresh);
    editedMs.push(ms);
    if (next.files.get(manifest.edit.file)?.hash !== sha256(edited)) throw new Error("edited refresh missed the benchmark edit");
    const { equal, sha } = await compareFull(next, sample, "product");
    await fs.writeFile(editPath, original);
    index = await refresh();
    report.refresh.edited.push({ incrementalEqualsFull: equal, revertedEqualsBaseline: serializeArtifact(index).equals(baseline), editedSha256: sha });
  }
  report.refresh.editedMs = describeSamples(editedMs);

  const parts = { scan: [] as number[], fullHashFreshness: [] as number[], applyChanges: [] as number[], saveArtifact: [] as number[], total: [] as number[] };
  for (let sample = 0; sample < editSamples; sample += 1) {
    await fs.writeFile(editPath, edited);
    const [, scanMs] = await timed(() => scanFiles(workspace));
    const [delta, detectMs] = await timed(() => freshness(index, workspace));
    if (!delta.changed.includes(manifest.edit.file)) throw new Error("freshness missed the benchmark edit");
    const [next, applyMs] = await timed(() => applyChanges(index, workspace, [...delta.added, ...delta.changed, ...delta.deleted]));
    const [, saveMs] = await timed(() => saveArtifact(next, canonicalCache));
    parts.scan.push(scanMs); parts.fullHashFreshness.push(detectMs); parts.applyChanges.push(applyMs); parts.saveArtifact.push(saveMs);
    parts.total.push(scanMs + detectMs + applyMs + saveMs);
    const { equal, sha } = await compareFull(next, sample, "decomposed");
    await fs.writeFile(editPath, original);
    index = await refresh();
    report.refresh.editedDecomposed.push({ incrementalEqualsFull: equal, revertedEqualsBaseline: serializeArtifact(index).equals(baseline), editedSha256: sha });
  }
  report.refresh.editedDecomposedMs = {
    scan: describeSamples(parts.scan), fullHashFreshness: describeSamples(parts.fullHashFreshness),
    applyChanges: describeSamples(parts.applyChanges), saveArtifact: describeSamples(parts.saveArtifact), total: describeSamples(parts.total),
  };
}

// Without a reset, VmHWM is the peak since process start (startup and the first build included), not the query peak.
export function queryPeakKiB(resetApplied: boolean, afterQueries: ProcMemory): number | null {
  return resetApplied ? afterQueries.hwmKiB : null;
}

async function measureStdio(options: WorkloadOptions, workspace: string, primed: string, report: WorkloadReport): Promise<void> {
  const first = options.queries[0];
  if (first === undefined) throw new Error("no queries");
  const session = await launch(options.bin, workspace, primed);
  const memory = report.mcp.memory;
  memory.pid = session.pid;
  let polling = true;
  try {
    const opening = await call(session.client, first);
    if (opening.error !== null) report.errors.push(`warm session first query: ${opening.error}`);
    await sleep(options.settleMs);
    const pid = session.pid;
    if (pid !== null) {
      memory.idle = await readProcMemory(pid);
      for (const child of await childPids(pid)) if (!memory.childPidsSeen.includes(child)) memory.childPidsSeen.push(child);
    }
    const listMs: number[] = [];
    for (let i = 0; i < options.samples; i += 1) listMs.push((await timed(() => session.client.listTools()))[1]);
    report.mcp.listToolsMs = describeSamples(listMs);
    if (pid !== null) memory.peakResetApplied = await resetPeakMemory(pid);
    const poller = (async () => {
      while (polling && pid !== null) {
        const now = await readProcMemory(pid);
        memory.rssPollSamples += 1;
        if (now.rssKiB !== null) memory.sampledMaxRssKiB = Math.max(memory.sampledMaxRssKiB ?? 0, now.rssKiB);
        for (const child of await childPids(pid)) if (!memory.childPidsSeen.includes(child)) memory.childPidsSeen.push(child);
        await sleep(5);
      }
    })();
    report.mcp.warmStdio.queries = await measureQueries(session.client, options.queries, options.samples, options.warmups, 600);
    polling = false;
    await poller;
    if (pid !== null) {
      memory.peakDuringQueryKiB = queryPeakKiB(memory.peakResetApplied, await readProcMemory(pid));
      await sleep(options.settleMs);
      memory.idleAfterQueries = await readProcMemory(pid);
    }
    memory.childPidsSeen.sort((a, b) => a - b);
  } finally {
    polling = false;
    await session.client.close();
  }
}

async function measureInProcess(options: WorkloadOptions, workspace: string, primed: string, report: WorkloadReport): Promise<void> {
  const { server, refresh, status, close } = createOsnovaMcpServer(workspace, { cacheDir: primed, watch: true, prewarm: true });
  const client = new Client({ name: "osnova-bench", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await refresh();
    const deadline = Date.now() + 300_000;
    while (status().warm !== "warm" && Date.now() < deadline) await sleep(20);
    if (status().warm !== "warm") report.errors.push(`in-process prewarm did not finish: ${status().warm}`);
    report.mcp.warmInProcess.queries = await measureQueries(client, options.queries, options.samples, options.warmups, 0, () => status().refreshes);
  } finally {
    await close();
    await client.close();
  }
}

export function emptyReport(options: WorkloadOptions): WorkloadReport {
  const manifest = options.manifest;
  const none = describeSamples([]);
  const noMemory: ProcMemory = { rssKiB: null, hwmKiB: null, threads: null };
  return {
    schemaVersion: 1, workload: manifest.id, status: "completed", errors: [], manifestFingerprint: manifestFingerprint(manifest),
    sourceRevision: manifest.source.kind === "checkout" ? manifest.source.revision : null,
    snapshotFingerprint: null, snapshotFiles: 0,
    snapshotExclusions: { declared: manifest.source.kind === "checkout" ? manifest.source.exclude ?? [] : [], files: [] },
    execution: {
      inProcess: "tsx-source", mcpServer: path.relative(repository, options.bin), node: process.version, platform: process.platform, arch: process.arch,
      settings: { samples: options.samples, warmups: options.warmups, coldSamples: options.coldSamples, buildSamples: options.buildSamples, editSamples: options.editSamples, settleMs: options.settleMs },
    },
    hostStart: hostFacts(), hostEnd: null, builds: [],
    refresh: {
      scanMs: none, fullHashFreshnessMs: none, noChangeMemory: none, loadIndexMs: none, serializeMs: none, saveArtifactMs: none,
      editedMs: none, edited: [], editedDecomposedMs: { scan: none, fullHashFreshness: none, applyChanges: none, saveArtifact: none, total: none },
      editedDecomposed: [], repeatedSerializeIdentical: null,
    },
    mcp: {
      processVersionMs: none, coldBuild: [], coldPersisted: [], priming: null, listToolsMs: none,
      warmStdio: { description: "stdio dist/bin.js mcp, default flags (no --watch, prewarm on): every call verifies the working tree with a no-change refreshWorkspace before answering; client-observed round trip", queries: [] },
      warmInProcess: { description: "in-process createOsnovaMcpServer with watch: true over InMemoryTransport: calls reuse the verified index; samples whose call refreshed the index are retried and counted", queries: [] },
      memory: {
        pid: null,
        scope: "the dist/bin.js mcp node process only (its worker threads included); child processes are listed but their memory is not counted. " +
          "peakDuringQueryKiB is VmHWM after a reset before the queries, null when the reset failed; sampledMaxRssKiB is the largest polled VmRSS during the queries",
        idle: noMemory, idleAfterQueries: noMemory, peakResetApplied: false, peakDuringQueryKiB: null, sampledMaxRssKiB: null, rssPollSamples: 0, childPidsSeen: [],
      },
    },
  };
}

export async function measureWorkload(options: WorkloadOptions): Promise<WorkloadReport> {
  const log = options.log ?? (() => undefined);
  const report = emptyReport(options);
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(options.temporaryRoot ?? os.tmpdir(), "osnova-mcp-perf-")));
  try {
    const workspace = path.join(temporary, "workspace");
    log(`snapshot ${options.manifest.id}`);
    const { files, excluded, fingerprint } = await writeSnapshot(options.manifest, options.workspace, workspace);
    report.snapshotFingerprint = fingerprint;
    report.snapshotFiles = files.size;
    report.snapshotExclusions.files = excluded;
    const original = files.get(options.manifest.edit.file);
    if (original === undefined) throw new Error("edit file missing from snapshot");
    const first = options.queries[0];
    if (first === undefined) throw new Error("no queries");

    for (let i = 0; i < options.buildSamples; i += 1) {
      log(`build child ${i + 1}/${options.buildSamples}`);
      report.builds.push(await runBuildChild(workspace, path.join(temporary, `cache-build-${i}`)));
      await fs.rm(path.join(temporary, `cache-build-${i}`), { recursive: true, force: true });
    }
    log("refresh breakdown");
    await measureRefresh(options, workspace, temporary, original, report);

    log("process startup");
    const versionMs: number[] = [];
    for (let i = 0; i < options.coldSamples; i += 1) versionMs.push(await runProcess([options.bin, "--version"]));
    report.mcp.processVersionMs = describeSamples(versionMs);
    for (let i = 0; i < options.coldSamples; i += 1) {
      log(`mcp cold start with build ${i + 1}/${options.coldSamples}`);
      const cacheDir = path.join(temporary, `cache-cold-${i}`);
      const sample = await coldStart(options.bin, workspace, cacheDir, first);
      sample.artifactSha256 = (await storedArtifact(workspace, await fs.realpath(cacheDir)))?.sha ?? null;
      report.mcp.coldBuild.push(sample);
      if (sample.firstQueryError !== null) report.errors.push(`cold build first query: ${sample.firstQueryError}`);
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
    const primed = path.join(temporary, "cache-primed");
    log("mcp priming session");
    report.mcp.priming = await coldStart(options.bin, workspace, primed, first);
    for (let i = 0; i < options.coldSamples; i += 1) {
      log(`mcp cold start with persisted index ${i + 1}/${options.coldSamples}`);
      const sample = await coldStart(options.bin, workspace, primed, first);
      report.mcp.coldPersisted.push(sample);
      if (sample.firstQueryError !== null) report.errors.push(`cold persisted first query: ${sample.firstQueryError}`);
    }
    log("mcp warm stdio session");
    await measureStdio(options, workspace, primed, report);
    log("mcp warm in-process session");
    await measureInProcess(options, workspace, primed, report);
  } catch (error) {
    report.errors.push(message(error));
  } finally {
    report.hostEnd = hostFacts();
    await fs.rm(temporary, { recursive: true, force: true });
  }
  return finalizeReport(report);
}

// Adds the failures the measurements themselves recorded, so a run that broke determinism cannot report completed.
export function finalizeReport(report: WorkloadReport): WorkloadReport {
  for (const [label, mode] of [["stdio", report.mcp.warmStdio], ["in-process", report.mcp.warmInProcess]] as const) {
    for (const query of mode.queries) {
      if (query.errors.length > 0) report.errors.push(`${query.id}: ${query.errors[0]}`);
      if (!query.stableResponse) report.errors.push(`${query.id}: ${label} responses differ across samples`);
    }
  }
  if (report.refresh.repeatedSerializeIdentical === false) report.errors.push("repeated serialization of one index produced different bytes");
  if ([...report.refresh.edited, ...report.refresh.editedDecomposed].some((sample) => !sample.incrementalEqualsFull || !sample.revertedEqualsBaseline)) {
    report.errors.push("incremental/full mismatch");
  }
  if (new Set([...report.builds.map((build) => build.artifactSha256), ...report.mcp.coldBuild.map((sample) => sample.artifactSha256)]).size > 1) {
    report.errors.push("repeated full builds produced different artifacts");
  }
  if (report.errors.length > 0) report.status = "failed";
  return report;
}

function parseQueries(value: unknown): McpQuery[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("queries must be a nonempty array");
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    const item = entry as Partial<McpQuery>;
    if (typeof item.id !== "string" || ids.has(item.id)) throw new Error("query ids must be unique strings");
    ids.add(item.id);
    if (!mcpToolNames.includes(item.tool as McpToolName)) throw new Error(`unknown tool in query ${item.id}`);
    if (typeof item.arguments !== "object" || item.arguments === null) throw new Error(`query ${item.id} needs arguments`);
    if (item.size !== "small" && item.size !== "large") throw new Error(`query ${item.id} needs size small or large`);
    if (typeof item.expectEmpty !== "boolean") throw new Error(`query ${item.id} needs expectEmpty`);
    return { id: item.id, tool: item.tool as McpToolName, arguments: item.arguments, size: item.size, expectEmpty: item.expectEmpty, note: item.note };
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    manifest: { type: "string" }, workspace: { type: "string" }, queries: { type: "string" }, output: { type: "string" },
    samples: { type: "string", default: "20" }, warmups: { type: "string", default: "3" }, "cold-samples": { type: "string", default: "5" },
    "build-samples": { type: "string", default: "5" }, "edit-samples": { type: "string", default: "10" }, "settle-ms": { type: "string", default: "3000" },
    bin: { type: "string" }, "build-child": { type: "boolean" }, "cache-dir": { type: "string" },
  } });
  if (values["build-child"] === true) {
    if (values.workspace === undefined || values["cache-dir"] === undefined) throw new Error("build child needs --workspace and --cache-dir");
    await buildChild(values.workspace, values["cache-dir"]);
    return;
  }
  if (values.manifest === undefined || values.queries === undefined || values.output === undefined) throw new Error("--manifest, --queries and --output are required");
  const count = (name: string, raw: string, min: number): number => {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`${name} must be an integer of at least ${min}`);
    return value;
  };
  const manifest = parseManifest(JSON.parse(await fs.readFile(path.resolve(values.manifest), "utf8")));
  const queries = parseQueries(JSON.parse(await fs.readFile(path.resolve(values.queries), "utf8")));
  const report = await measureWorkload({
    manifest, queries, workspace: values.workspace === undefined ? undefined : path.resolve(values.workspace),
    samples: count("samples", values.samples, 1), warmups: count("warmups", values.warmups, 0), coldSamples: count("cold-samples", values["cold-samples"], 1),
    buildSamples: count("build-samples", values["build-samples"], 1), editSamples: count("edit-samples", values["edit-samples"], 1),
    settleMs: count("settle-ms", values["settle-ms"], 0), bin: path.resolve(values.bin ?? path.join(repository, "dist/bin.js")),
    log: (line) => process.stderr.write(`[${new Date().toISOString()}] ${line}\n`),
  });
  await fs.writeFile(path.resolve(values.output), `${JSON.stringify(report, null, 1)}\n`, { flag: "wx" });
  process.stdout.write(`mcp-perf ${report.workload}: ${report.status}${report.errors.length > 0 ? ` (${report.errors.join("; ")})` : ""}\n`);
  if (report.status !== "completed") process.exitCode = 2;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === harnessFile) {
  await main().catch((error: unknown) => {
    process.stderr.write(`mcp-perf failed: ${message(error)}\n`);
    process.exitCode = 2;
  });
}

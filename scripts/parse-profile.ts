#!/usr/bin/env -S npx tsx
// Split a full build into its phases on pinned checkouts and write one record.
// Phases are timed in-process on one thread so each number is attributable; the wall-clock
// rows at the end are what a user sees with the default extraction pool and with the pool off.
// usage: npx tsx scripts/parse-profile.ts --workspace zod=/path --workspace click=/path --output benchmarks/results/parse-profile-<date>.json [--repeats 3]
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, promises as fs, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex } from "../src/index.js";
import { extractCard, finalizeIndex } from "../src/index/build.js";
import type { RawEdgeItem } from "../src/index/indexImpl.js";
import { saveArtifact, serializeArtifact } from "../src/index/serialize.js";
import { scanFiles, sha256Hex, sourceText } from "../src/index/scan.js";
import { workspaceFilePath } from "../src/index/workspace.js";
import { discardParser, getParser } from "../src/grammar/loader.js";
import { languageForPath } from "../src/grammar/languages.js";
import { adapterFor } from "../src/extract/adapters.js";
import { markShadowed } from "../src/extract/scope.js";
import { forgetTree } from "../src/extract/util.js";
import type { FileCard, LanguageId } from "../src/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const workspaces = new Map<string, string>();
let output: string | undefined;
let repeats = 3;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]!;
  if (arg === "--workspace") { const [name, dir] = args[++i]!.split("="); workspaces.set(name!, path.resolve(dir!)); }
  else if (arg === "--output") output = path.resolve(args[++i]!);
  else if (arg === "--repeats") repeats = Number(args[++i]);
  else throw new Error(`unknown argument ${arg}`);
}
if (workspaces.size === 0 || output === undefined) throw new Error("need at least one --workspace name=path and --output");
if (existsSync(output)) throw new Error(`refusing to overwrite ${output}`);

const git = (dir: string, ...rest: string[]): string => execFileSync("git", ["-C", dir, ...rest], { encoding: "utf8" }).trim();
const median = (values: number[]): number => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]!; };
const round = (value: number): number => Math.round(value * 10) / 10;
const now = (): number => performance.now();

interface PhaseSample {
  scan: number; grammarLoad: number; read: number; parse: number; walk: number; extractTotal: number; resolve: number; serialize: number; save: number;
  failures: string[];
  parseByLanguage: Record<string, number>; walkByLanguage: Record<string, number>; filesByLanguage: Record<string, number>; bytesByLanguage: Record<string, number>;
}

async function phases(absRoot: string, cacheDir: string): Promise<PhaseSample> {
  const scanStart = now();
  const scan = await scanFiles(absRoot);
  const scanMs = now() - scanStart;

  const grammarStart = now();
  for (const language of new Set(scan.paths.map((relPath) => languageForPath(relPath)).filter((language): language is LanguageId => language !== undefined))) await getParser(language);
  const grammarLoad = now() - grammarStart;
  // One untimed pass so every timed number below is steady-state; the wall-clock rows keep the cold cost.
  for (const relPath of scan.paths) await extractCard(absRoot, relPath);

  let readMs = 0, parseMs = 0, walkMs = 0;
  const failures: string[] = [];
  const parseByLanguage: Record<string, number> = {}, walkByLanguage: Record<string, number> = {}, filesByLanguage: Record<string, number> = {}, bytesByLanguage: Record<string, number> = {};
  for (const relPath of scan.paths) {
    const t0 = now();
    const buffer = await fs.readFile(await workspaceFilePath(absRoot, relPath));
    sha256Hex(buffer);
    const text = sourceText(buffer);
    readMs += now() - t0;
    const language = languageForPath(relPath);
    if (text === null || language === undefined) continue;
    filesByLanguage[language] = (filesByLanguage[language] ?? 0) + 1;
    bytesByLanguage[language] = (bytesByLanguage[language] ?? 0) + buffer.length;
    const parser = await getParser(language as LanguageId);
    const t1 = now();
    let tree;
    try { tree = parser.parse(text); } catch (error) { discardParser(language as LanguageId); failures.push(`${relPath}: parse: ${String(error)}`); continue; }
    const p = now() - t1;
    parseMs += p; parseByLanguage[language] = (parseByLanguage[language] ?? 0) + p;
    if (tree === null) continue;
    const t2 = now();
    try {
      const out = adapterFor(language as LanguageId).extract(tree, text);
      markShadowed(tree, out.definitions);
    } catch (error) { discardParser(language as LanguageId); failures.push(`${relPath}: walk: ${String(error)}`); }
    finally { tree.delete(); forgetTree(tree); }
    const w = now() - t2;
    walkMs += w; walkByLanguage[language] = (walkByLanguage[language] ?? 0) + w;
  }

  const files = new Map<string, FileCard>();
  const rawEdges = new Map<string, RawEdgeItem[]>();
  const extractStart = now();
  for (const relPath of scan.paths) {
    const { card, rawEdges: fileEdges } = await extractCard(absRoot, relPath);
    files.set(card.path, card);
    if (fileEdges.length > 0) rawEdges.set(card.path, fileEdges);
  }
  const extractTotal = now() - extractStart;

  const resolveStart = now();
  const index = finalizeIndex(absRoot, files, rawEdges);
  const resolveMs = now() - resolveStart;

  const serializeStart = now();
  serializeArtifact(index);
  const serializeMs = now() - serializeStart;

  const saveStart = now();
  await saveArtifact(index, cacheDir);
  const saveMs = now() - saveStart;

  return { scan: scanMs, grammarLoad, read: readMs, parse: parseMs, walk: walkMs, extractTotal, resolve: resolveMs, serialize: serializeMs, save: saveMs, failures, parseByLanguage, walkByLanguage, filesByLanguage, bytesByLanguage };
}

async function wallClock(absRoot: string, workers: string | undefined): Promise<number> {
  const previous = process.env.OSNOVA_EXTRACT_WORKERS;
  if (workers === undefined) delete process.env.OSNOVA_EXTRACT_WORKERS; else process.env.OSNOVA_EXTRACT_WORKERS = workers;
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "osnova-profile-wall-"));
  try {
    const start = now();
    await buildIndex(absRoot, { cacheDir });
    return now() - start;
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OSNOVA_EXTRACT_WORKERS; else process.env.OSNOVA_EXTRACT_WORKERS = previous;
  }
}

const corpora = [];
for (const [name, dir] of [...workspaces].sort(([a], [b]) => (a < b ? -1 : 1))) {
  const coverageOnly = path.join(root, "benchmarks", "corpora", `${name}.json`);
  const manifest = JSON.parse(readFileSync(existsSync(coverageOnly) ? coverageOnly : path.join(root, "benchmarks", `${name}-v1.json`), "utf8")) as { id: string; source: { kind: string; revision: string; repository: string } };
  if (manifest.source.kind !== "checkout") throw new Error(`${name}: manifest is not a checkout corpus`);
  const head = git(dir, "rev-parse", "HEAD");
  if (head !== manifest.source.revision) throw new Error(`${name}: checkout is at ${head}, manifest pins ${manifest.source.revision}`);

  const samples: PhaseSample[] = [];
  for (let i = 0; i < repeats; i += 1) {
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), "osnova-profile-"));
    try { samples.push(await phases(dir, cacheDir)); } finally { rmSync(cacheDir, { recursive: true, force: true }); }
  }
  const pick = (key: keyof PhaseSample): number => round(median(samples.map((s) => s[key] as number)));
  const pickMap = (key: "parseByLanguage" | "walkByLanguage"): Record<string, number> =>
    Object.fromEntries(Object.keys(samples[0]![key]).sort().map((language) => [language, round(median(samples.map((s) => s[key][language] ?? 0)))]));
  const wallPool: number[] = [], wallSingle: number[] = [];
  for (let i = 0; i < repeats; i += 1) { wallPool.push(await wallClock(dir, undefined)); wallSingle.push(await wallClock(dir, "0")); }

  const phaseMs = { scan: pick("scan"), grammarLoad: pick("grammarLoad"), read: pick("read"), parse: pick("parse"), walk: pick("walk"), extractOther: round(pick("extractTotal") - pick("read") - pick("parse") - pick("walk")), resolve: pick("resolve"), serialize: pick("serialize"), save: pick("save") };
  const attributed = phaseMs.scan + phaseMs.grammarLoad + pick("extractTotal") + phaseMs.resolve + phaseMs.serialize + phaseMs.save;
  const share = Object.fromEntries(Object.entries(phaseMs).map(([k, v]) => [k, Math.round((v / attributed) * 1000) / 1000]));
  const row = {
    corpus: manifest.id, repository: manifest.source.repository, revision: head,
    files: samples[0]!.filesByLanguage, bytes: samples[0]!.bytesByLanguage,
    repeats, phaseMs, phaseShare: share, attributedMs: round(attributed), extractionFailures: samples[0]!.failures,
    parseMsByLanguage: pickMap("parseByLanguage"), walkMsByLanguage: pickMap("walkByLanguage"),
    wallClockMs: { defaultPool: round(median(wallPool)), singleThread: round(median(wallSingle)) },
  };
  corpora.push(row);
  process.stdout.write(`${name}: parse ${phaseMs.parse} ms (${Math.round(share.parse! * 100)}%), walk ${phaseMs.walk} ms (${Math.round(share.walk! * 100)}%), resolve ${phaseMs.resolve} ms (${Math.round(share.resolve! * 100)}%), serialize+save ${round(phaseMs.serialize + phaseMs.save)} ms (${Math.round((share.serialize! + share.save!) * 100)}%); wall pool ${row.wallClockMs.defaultPool} ms, single ${row.wallClockMs.singleThread} ms\n`);
}

const record = {
  schemaVersion: 1,
  measured: "full build split by phase on pinned checkouts, single thread, steady state after one untimed pass, median of repeats; wall clock with the default extraction pool and with the pool off",
  osnova: { commit: git(root, "rev-parse", "HEAD"), version: (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version },
  host: { platform: process.platform, arch: process.arch, node: process.version, cpus: os.availableParallelism() },
  phases: {
    scan: "directory walk and ignore rules",
    grammarLoad: "first load of every WASM grammar the corpus needs, once per process",
    read: "file read, SHA-256 and UTF-8 decode",
    parse: "tree-sitter parse of the source text into a syntax tree (WASM grammar)",
    walk: "adapter walk of the tree into definitions and raw edges, plus shadowed-declaration marking",
    extractOther: "the rest of extractCard: symbol assembly, sorting and card construction",
    resolve: "edge resolution across files: imports, re-exports, bindings, receivers",
    serialize: "artifact assembly and JSON encoding in memory",
    save: "gzip and write of the core, edges and text sections",
  },
  corpora,
  reading: "parse is the WASM grammar; walk, resolve, serialize and save are TypeScript. Native grammar bindings could only shorten the parse row.",
};
writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`wrote ${output}\n`);

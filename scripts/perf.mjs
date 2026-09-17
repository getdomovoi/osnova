#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../dist/index.js";
import { applyChanges, freshness } from "../dist/index.js";
import { serializeArtifact } from "../dist/index.js";
import { loadIndex } from "../dist/index.js";
import { scanFiles } from "../dist/index.js";
import { scopedAsk } from "../dist/index.js";

const FILE_COUNT = 300;
const BUDGET_BUILD_MS = 30_000;
const BUDGET_INCREMENTAL_MS = 5_000;
const BUDGET_HEAP_BYTES = 512 * 1024 * 1024;
const BUDGET_CORE_LOAD_MS = 80;
const BUDGET_SCAN_MS = 40;
const BUDGET_EDGES_LOAD_MS = 40;
const BUDGET_NOCHANGE_REFRESH_MS = 120;
const BUDGET_CHANGED_REFRESH_MS = 800;
const BUDGET_SCOPED_ASK_MS = 80;

function generate(root) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const modules = 30;
  const filesPerModule = Math.ceil(FILE_COUNT / modules);
  for (let m = 0; m < modules; m += 1) {
    const dir = path.join(root, `mod${m}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < filesPerModule; f += 1) {
      const lines = [];
      lines.push(`export interface Shape${m}_${f} { size: number; label: string; }`);
      lines.push(`export const LIMIT_${m}_${f} = ${m * 100 + f};`);
      lines.push(`export class Widget${m}_${f} {`);
      lines.push(`  private label = "w${m}_${f}";`);
      lines.push(`  describe(): string { return \`\${this.label} \${LIMIT_${m}_${f}}\`; }`);
      lines.push(`}`);
      lines.push(`export function make${m}_${f}(size: number): Shape${m}_${f} {`);
      lines.push(`  const w = new Widget${m}_${f}();`);
      lines.push(`  return { size: size + LIMIT_${m}_${f}, label: w.describe() };`);
      lines.push(`}`);
      const next = f + 1 < filesPerModule ? f + 1 : 0;
      lines.push(`export function chain${m}_${f}(v: number): number {`);
      lines.push(`  return make${m}_${next}(v).size;`);
      lines.push(`}`);
      fs.writeFileSync(path.join(dir, `file${f}.ts`), `${lines.join("\n")}\n`);
    }
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-perf-"));
  const cacheDir = path.join(root, "cache");
  const repo = path.join(root, "repo");
  generate(repo);

  const buildStart = performance.now();
  let index = await buildIndex(repo, { cacheDir });
  const buildMs = performance.now() - buildStart;
  const artifactBytes = serializeArtifact(index).length;
  const heapUsed = process.memoryUsage().heapUsed;

  const changed = [];
  for (let i = 0; i < 10; i += 1) {
    const file = path.join(repo, `mod${i}`, "file0.ts");
    fs.appendFileSync(file, `export function extra${i}(v: number): number { return v + ${i}; }\n`);
    changed.push(`mod${i}/file0.ts`);
  }

  const refreshStart = performance.now();
  const report = await freshness(index, repo);
  index = await applyChanges(index, repo, [...report.added, ...report.changed, ...report.deleted]);
  const incrementalMs = performance.now() - refreshStart;

  const scanStart = performance.now();
  const scan = await scanFiles(repo);
  const scanMs = performance.now() - scanStart;

  const failures = [];
  if (scan.paths.length !== FILE_COUNT) failures.push(`scan found ${scan.paths.length} files, expected ${FILE_COUNT}`);
  if (scanMs > BUDGET_SCAN_MS) failures.push(`scan ${scanMs.toFixed(0)}ms > ${BUDGET_SCAN_MS}ms`);

  const loadStart = performance.now();
  const reloaded = await loadIndex(repo, { cacheDir });
  const coreLoadMs = performance.now() - loadStart;
  if (reloaded === undefined) failures.push("core load returned undefined");

  const edgesStart = performance.now();
  const edgeCount = reloaded.edges.length;
  const edgesLoadMs = performance.now() - edgesStart;

  scopedAsk(reloaded, "chain widget", { limit: 8 });
  const scopedAskStart = performance.now();
  scopedAsk(reloaded, "chain widget", { limit: 8 });
  const scopedAskMs = performance.now() - scopedAskStart;
  if (scopedAskMs > BUDGET_SCOPED_ASK_MS) failures.push(`scopedAsk ${scopedAskMs.toFixed(0)}ms > ${BUDGET_SCOPED_ASK_MS}ms`);

  const { refreshWorkspace } = await import("../dist/index.js");
  await refreshWorkspace(repo, { cacheDir });
  const noChangeStart = performance.now();
  await refreshWorkspace(repo, { cacheDir });
  const noChangeMs = performance.now() - noChangeStart;
  if (edgeCount === 0) failures.push("edges section empty");
  if (edgesLoadMs > BUDGET_EDGES_LOAD_MS) failures.push(`edgesLoad ${edgesLoadMs.toFixed(0)}ms > ${BUDGET_EDGES_LOAD_MS}ms`);
  if (noChangeMs > BUDGET_NOCHANGE_REFRESH_MS) failures.push(`noChangeRefresh ${noChangeMs.toFixed(0)}ms > ${BUDGET_NOCHANGE_REFRESH_MS}ms`);

  const changedRelPath = "mod0/file0.ts";
  fs.appendFileSync(path.join(repo, "mod0", "file0.ts"), `export function perfProbeMarker(v: number): number { return v + 1; }\n`);
  const changedStart = performance.now();
  const changedIndex = await refreshWorkspace(repo, { cacheDir });
  const changedRefreshMs = performance.now() - changedStart;
  const changedCard = changedIndex.files.get(changedRelPath);
  if (changedCard === undefined || !changedCard.text.includes("perfProbeMarker")) failures.push("changed refresh missed the edit");
  if (changedRefreshMs > BUDGET_CHANGED_REFRESH_MS) failures.push(`changedRefresh ${changedRefreshMs.toFixed(0)}ms > ${BUDGET_CHANGED_REFRESH_MS}ms`);

  console.log(`files: ${index.files.size} symbols: ${index.symbols.size} edges: ${index.edges.length}`);
  console.log(`build: ${buildMs.toFixed(0)}ms incremental: ${incrementalMs.toFixed(0)}ms coreLoad: ${coreLoadMs.toFixed(0)}ms scan: ${scanMs.toFixed(0)}ms edgesLoad: ${edgesLoadMs.toFixed(0)}ms noChangeRefresh: ${noChangeMs.toFixed(0)}ms changedRefresh: ${changedRefreshMs.toFixed(0)}ms scopedAsk: ${scopedAskMs.toFixed(0)}ms artifact: ${(artifactBytes / 1024).toFixed(0)}KiB heap: ${(heapUsed / 1024 / 1024).toFixed(0)}MiB`);

  if (buildMs > BUDGET_BUILD_MS) failures.push(`build ${buildMs.toFixed(0)}ms > ${BUDGET_BUILD_MS}ms`);
  if (incrementalMs > BUDGET_INCREMENTAL_MS) failures.push(`incremental ${incrementalMs.toFixed(0)}ms > ${BUDGET_INCREMENTAL_MS}ms`);
  if (coreLoadMs > BUDGET_CORE_LOAD_MS) failures.push(`coreLoad ${coreLoadMs.toFixed(0)}ms > ${BUDGET_CORE_LOAD_MS}ms`);
  if (heapUsed > BUDGET_HEAP_BYTES) failures.push(`heap ${(heapUsed / 1048576).toFixed(0)}MiB > ${BUDGET_HEAP_BYTES / 1048576}MiB`);
  if (changed.length > 0 && report.changed.length < changed.length) failures.push("freshness missed edits");

  fs.rmSync(root, { recursive: true, force: true });
  if (failures.length > 0) {
    console.error(`perf budget exceeded: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("perf budgets met");
}

await main();

#!/usr/bin/env node
// Measure call-site resolution coverage on the pinned benchmark checkouts and write one record.
// Every corpus is also loaded back from its cache and its edges decoded, so a binding shape the
// serializer writes but the validator rejects fails here instead of in a fresh MCP process.
// usage: node scripts/coverage-corpora.mjs --workspace pyright=/path --workspace zod=/path --workspace click=/path --output benchmarks/results/resolution-coverage-<date>.json
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { buildIndex, loadIndex, resolutionCoverage } = await import(path.join(root, "dist", "index.js"));
const args = process.argv.slice(2);
const workspaces = new Map();
let output;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--workspace") { const [name, dir] = args[++i].split("="); workspaces.set(name, path.resolve(dir)); }
  else if (args[i] === "--output") output = path.resolve(args[++i]);
  else throw new Error(`unknown argument ${args[i]}`);
}
if (workspaces.size === 0 || output === undefined) throw new Error("need at least one --workspace name=path and --output");
if (existsSync(output)) throw new Error(`refusing to overwrite ${output}`);
const git = (dir, ...rest) => execFileSync("git", ["-C", dir, ...rest], { encoding: "utf8" }).trim();
const corpora = [];
for (const [name, dir] of [...workspaces].sort(([a], [b]) => (a < b ? -1 : 1))) {
  const coverageOnly = path.join(root, "benchmarks", "corpora", `${name}.json`);
  const manifest = JSON.parse(readFileSync(existsSync(coverageOnly) ? coverageOnly : path.join(root, "benchmarks", `${name}-v1.json`), "utf8"));
  if (manifest.source?.kind !== "checkout") throw new Error(`${name}: manifest is not a checkout corpus`);
  const head = git(dir, "rev-parse", "HEAD");
  if (head !== manifest.source.revision) throw new Error(`${name}: checkout at ${head}, manifest wants ${manifest.source.revision}`);
  const dirty = git(dir, "status", "--porcelain", "--untracked-files=no");
  if (dirty.length > 0) throw new Error(`${name}: checkout has modified tracked files`);
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), `osnova-coverage-${name}-`));
  try {
    const index = await buildIndex(dir, { cacheDir });
    const report = resolutionCoverage(index);
    const loaded = await loadIndex(dir, { cacheDir });
    if (loaded === undefined) throw new Error(`${name}: cache written by this build did not load back`);
    const builtEdges = [...index.edges].length, loadedEdges = [...loaded.edges].length;
    if (builtEdges !== loadedEdges) throw new Error(`${name}: ${builtEdges} edges built, ${loadedEdges} loaded back from the cache`);
    const reloaded = resolutionCoverage(loaded);
    if (reloaded.total.resolved !== report.total.resolved) throw new Error(`${name}: ${report.total.resolved} resolved in the build, ${reloaded.total.resolved} after reload`);
    corpora.push({ corpus: manifest.id, repository: manifest.source.repository, revision: head, generation: report.generation, cacheRoundTrip: { edges: loadedEdges, resolved: reloaded.total.resolved }, total: report.total, languages: report.languages, limitations: report.limitations });
    console.log(`${name}: ${report.total.resolved}/${report.total.calls} call sites resolved (${(report.total.resolvedShare * 100).toFixed(1)}%); cache round trip ${loadedEdges} edges`);
  } finally { rmSync(cacheDir, { recursive: true, force: true }); }
}
const record = { schemaVersion: 1, measured: "call-site resolution coverage on pinned checkouts", osnova: { commit: git(root, "rev-parse", "HEAD"), version: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version }, corpora };
writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);
console.log(`wrote ${output}`);

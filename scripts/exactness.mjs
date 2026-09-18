#!/usr/bin/env node
// usage: node scripts/exactness.mjs --workspace click=/path --workspace pyright=/path ... --output benchmarks/results/grep-vs-graph-<date>.json
// Compares a naive text search with the resolved call graph against hand-verified call-site sets.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, callersDetailed } from "../dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const workspaces = new Map();
let output;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--workspace") { const [name, dir] = args[++i].split("="); workspaces.set(name, path.resolve(dir)); }
  else if (args[i] === "--output") output = path.resolve(args[++i]);
}
if (output === undefined || existsSync(output)) throw new Error("give a fresh --output path");
const manifest = JSON.parse(readFileSync(path.join(root, "benchmarks", "exactness", "exactness-v1.json"), "utf8"));
const corpusRevision = (name) => JSON.parse(readFileSync(existsSync(path.join(root, "benchmarks", "corpora", `${name}.json`)) ? path.join(root, "benchmarks", "corpora", `${name}.json`) : path.join(root, "benchmarks", `${name}-v1.json`), "utf8")).source.revision;
const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "osnova-exactness-"));
const indexes = new Map();
const results = [];
try {
  for (const item of manifest.cases) {
    const dir = workspaces.get(item.corpus);
    if (dir === undefined) throw new Error(`${item.corpus}: give --workspace ${item.corpus}=/path`);
    const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (head !== corpusRevision(item.corpus)) throw new Error(`${item.corpus}: checkout at ${head}, manifest wants ${corpusRevision(item.corpus)}`);
    if (!indexes.has(item.corpus)) indexes.set(item.corpus, await buildIndex(dir, { cacheDir: path.join(cacheRoot, item.corpus) }));
    const index = indexes.get(item.corpus);
    const inScope = (file) => file.startsWith(item.scope) && !new RegExp(item.exclude).test(file) && item.extensions.some((ext) => file.endsWith(ext));
    const grepSites = [];
    const pattern = new RegExp(item.grep);
    for (const [file, card] of index.files) {
      if (!inScope(file)) continue;
      card.text.split("\n").forEach((line, i) => { if (pattern.test(line)) grepSites.push(`${file}:${i + 1}`); });
    }
    const detailed = callersDetailed(index, item.symbol, { direction: "in", depth: item.depth });
    if (detailed.status !== "found") throw new Error(`${item.id}: ${item.symbol} is ${detailed.status}`);
    const graphSites = [...new Set(detailed.hits.filter((hit) => hit.kind === "calls" && hit.resolved && hit.file !== null && inScope(hit.file)).map((hit) => `${hit.file}:${hit.line}`))].sort();
    const truth = new Set(item.truth);
    const score = (sites) => { const set = new Set(sites); const hit = item.truth.filter((s) => set.has(s)); return { sites: sites.length, hit: hit.length, precision: sites.length === 0 ? 0 : +(hit.length / sites.length).toFixed(3), recall: +(hit.length / item.truth.length).toFixed(3), falsePositives: sites.filter((s) => !truth.has(s)), missed: item.truth.filter((s) => !set.has(s)) }; };
    results.push({ id: item.id, corpus: item.corpus, revision: head, symbol: detailed.target.qualifiedName, depth: item.depth, truth: item.truth.length, grep: { pattern: item.grep, ...score(grepSites.sort()) }, graph: score(graphSites) });
    const r = results.at(-1);
    console.log(`${item.id}: truth ${r.truth}; grep ${r.grep.sites} sites, precision ${r.grep.precision}, recall ${r.grep.recall}; graph ${r.graph.sites} sites, precision ${r.graph.precision}, recall ${r.graph.recall}`);
  }
  const osnova = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(output, JSON.stringify({ schemaVersion: 1, measured: new Date().toISOString(), osnova, manifest: manifest.id, cases: results, limitations: ["truth-sets-are-hand-verified-not-compiler-proven", "grep-is-the-first-regex-a-person-types-not-the-best-possible-search", "graph-recall-counts-resolved-call-edges-only"] }, null, 2) + "\n");
  console.log(`wrote ${output}`);
} finally { rmSync(cacheRoot, { recursive: true, force: true }); }

#!/usr/bin/env node
// Dump osnova's routes edges for pinned checkouts and, where a runtime route table is supplied,
// score them against it at the registration site: an edge is true when the oracle lists a route
// in the same file whose decorated definition starts between the edge line and the handler's
// first line, whose method set contains the edge's method, whose full path ends with the edge's
// literal path, and whose handler the edge resolved. Every oracle route without a true edge is a miss.
// usage: node scripts/routes-corpora.mjs --workspace name=/path[:oracle.json] ... --output benchmarks/results/route-edges-<date>.json
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { buildIndex } = await import(path.join(root, "dist", "index.js"));
const args = process.argv.slice(2);
const workspaces = new Map();
let output;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--workspace") { const [name, rest] = args[++i].split("="); const [dir, oracle] = rest.split(":"); workspaces.set(name, { dir: path.resolve(dir), oracle: oracle === undefined ? undefined : path.resolve(oracle) }); }
  else if (args[i] === "--output") output = path.resolve(args[++i]);
  else throw new Error(`unknown argument ${args[i]}`);
}
if (workspaces.size === 0 || output === undefined) throw new Error("need at least one --workspace name=path[:oracle.json] and --output");
if (existsSync(output)) throw new Error(`refusing to overwrite ${output}`);
const git = (dir, ...rest) => execFileSync("git", ["-C", dir, ...rest], { encoding: "utf8" }).trim();

const corpora = [];
for (const [name, { dir, oracle: oraclePath }] of [...workspaces].sort(([a], [b]) => (a < b ? -1 : 1))) {
  const manifest = JSON.parse(readFileSync(path.join(root, "benchmarks", "corpora", `${name}.json`), "utf8"));
  if (manifest.source?.kind !== "checkout") throw new Error(`${name}: manifest is not a checkout corpus`);
  const head = git(dir, "rev-parse", "HEAD");
  if (head !== manifest.source.revision) throw new Error(`${name}: checkout is at ${head}, manifest pins ${manifest.source.revision}`);
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), "osnova-routes-"));
  let index;
  try { index = await buildIndex(dir, { cacheDir }); } finally { rmSync(cacheDir, { recursive: true, force: true }); }
  const edges = index.edges.filter((edge) => edge.kind === "routes").map((edge) => {
    const target = edge.toSymbol === undefined ? undefined : index.symbols.get(edge.toSymbol);
    const resolution = edge.evidence.resolution;
    return { file: edge.fromFile, line: edge.line, method: edge.route.method, path: edge.route.path ?? null, handler: edge.toName, target: edge.toSymbol ?? null, targetLine: target?.span.startLine ?? null, basis: resolution.status === "resolved" ? resolution.method : `unresolved:${resolution.reason}` };
  });
  const byBasis = {};
  for (const edge of edges) byBasis[edge.basis] = (byBasis[edge.basis] ?? 0) + 1;
  const row = {
    corpus: manifest.id, repository: manifest.source.repository, revision: head,
    routeEdges: edges.length, resolved: edges.filter((edge) => edge.target !== null).length,
    literalPath: edges.filter((edge) => edge.path !== null).length, mounts: edges.filter((edge) => edge.method === "ANY").length,
    byBasis: Object.fromEntries(Object.entries(byBasis).sort()),
  };
  if (oraclePath !== undefined) {
    const oracle = JSON.parse(readFileSync(oraclePath, "utf8"));
    const verbs = edges.filter((edge) => edge.method !== "ANY");
    const covered = new Set();
    const falseEdges = [];
    for (const edge of verbs) {
      const hit = oracle.findIndex((route) => route.file === edge.file && route.line >= edge.line && (edge.targetLine === null || route.line <= edge.targetLine) &&
        (edge.path === null || route.path.endsWith(edge.path)) && route.methods.includes(edge.method) && edge.target !== null);
      if (hit >= 0) covered.add(hit); else falseEdges.push(edge);
    }
    row.oracle = { kind: "runtime route table", routes: oracle.length, scoredEdges: verbs.length, truePositive: verbs.length - falseEdges.length, falsePositive: falseEdges.length,
      recall: oracle.length === 0 ? null : covered.size / oracle.length, falseSamples: falseEdges.slice(0, 20), missed: oracle.filter((_, i) => !covered.has(i)).slice(0, 20) };
  }
  corpora.push(row);
  console.log(`${name}: ${row.routeEdges} route edges, ${row.resolved} resolved${row.oracle === undefined ? "" : `; oracle ${row.oracle.truePositive} true, ${row.oracle.falsePositive} false, recall ${row.oracle.recall}`}`);
}
const record = { schemaVersion: 1, measured: "routes edges on pinned checkouts, scored at the registration site against a runtime route table where one exists", osnova: { commit: git(root, "rev-parse", "HEAD"), version: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version }, corpora };
writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
console.log(`wrote ${output}`);

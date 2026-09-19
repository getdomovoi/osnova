#!/usr/bin/env node
// usage: node scripts/resolution-diff.mjs --base <ref> --head <ref> --corpus <path> [--limit N] [--only lost|gained|moved] [--dry] [--out file.json]
// Builds osnova at two git refs (worktrees under the temporary directory, node_modules linked from this checkout),
// indexes one corpus with each, and lists every call edge whose resolution changed: the regression check the
// per-corpus totals hide (a commit can gain 28 sites and lose 10 and still read as +18). Without a TypeSafe key,
// or with --dry, it prints the changed edges and stops. With TYPESAFE_API_KEY set it asks a System One model per
// edge which of the two targets the call site invokes, so a reviewer reads only the disputed ones; those
// judgments are review aids, never resolutions, and nothing here touches the index.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const base = opt("--base"), head = opt("--head"), corpus = path.resolve(opt("--corpus")); const limit = Number(opt("--limit", "40")); const dry = args.includes("--dry"); const out = opt("--out"); const only = opt("--only");
if (!base || !head || !corpus) throw new Error("need --base --head --corpus");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-jev-"));
// Cleanup on every exit, including a closed stdout pipe, so no worktree registration outlives the run.
const cleanup = () => { fs.rmSync(work, { recursive: true, force: true }); try { execFileSync("git", ["-C", REPO, "worktree", "prune"]); } catch { /* nothing to prune */ } };
process.on("exit", cleanup);

function buildAt(ref) {
  const dir = path.join(work, ref.replace(/[^\w.-]/g, "_"));
  execFileSync("git", ["-C", REPO, "worktree", "add", "-q", "--detach", dir, ref]);
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const r = spawnSync("pnpm", ["build"], { cwd: dir, encoding: "utf8" }); if (r.status !== 0) throw new Error(`build ${ref}: ${r.stderr.slice(-500)}`);
  return dir;
}
function dumpEdges(dir, tag) {
  const script = `
    import { buildIndex } from ${JSON.stringify(path.join(dir, "dist", "index.js"))};
    const index = await buildIndex(${JSON.stringify(corpus)}, { cacheDir: ${JSON.stringify(path.join(work, "cache-" + tag))} });
    const sig = (q) => { const s = index.symbols.get(q); if (!s) return null; const t = index.files.get(s.file)?.text.split("\\n"); return { symbol: q, file: s.file, line: s.span.startLine, signature: (t?.[s.span.startLine - 1] ?? "").trim().slice(0, 200) }; };
    const rows = [];
    for (const e of index.edges) { if (e.kind !== "calls") continue; const r = e.evidence?.resolution; rows.push({ key: e.fromFile + ":" + e.line + " " + e.toName, from: e.fromSymbol, status: r?.status ?? "none", reason: r?.reason ?? r?.method ?? "", target: e.toSymbol ? sig(e.toSymbol) : null }); }
    const text = (file, line) => { const t = index.files.get(file)?.text.split("\\n") ?? []; return t.slice(Math.max(0, line - 4), line).map((l, i) => (line - 3 + i) + ": " + l).join("\\n"); };
    // Two calls of one name on one line share file:line name; number them after sorting by target so the key is stable.
    const groups = new Map(); for (const r of rows) { const g = groups.get(r.key) ?? []; g.push(r); groups.set(r.key, g); }
    for (const [key, g] of groups) { if (g.length < 2) continue; g.sort((a, b) => (a.target?.symbol ?? a.status + a.reason).localeCompare(b.target?.symbol ?? b.status + b.reason)); g.forEach((r, i) => { r.key = key + " #" + i; }); }
    process.stdout.write(JSON.stringify({ files: [...index.files.keys()].sort(), rows, context: Object.fromEntries(rows.map((r) => { const [loc] = r.key.split(" "); const [file, line] = [loc.slice(0, loc.lastIndexOf(":")), Number(loc.slice(loc.lastIndexOf(":") + 1))]; return [r.key, text(file, line)]; })) }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", maxBuffer: 1 << 30 }); if (r.status !== 0) throw new Error(`dump ${tag}: ${r.stderr.slice(-800)}`);
  return JSON.parse(r.stdout);
}
async function judge(items) {
  const state = { edges: items.map((it, i) => ({ id: i, call: { file: it.key.split(" ")[0], context: it.context }, before: it.before.target ?? { symbol: null, note: it.before.status + " " + it.before.reason }, after: it.after.target ?? { symbol: null, note: it.after.status + " " + it.after.reason } })) };
  const questions = Object.fromEntries(items.map((it, i) => [`e${i}`, { type: "choice", instructions: `For \`edges[${i}]\`: the last line of \`edges[${i}].call.context\` contains a call. Given the receiver's declaration visible in the context lines and the two candidate definitions, which definition does that call invoke?`, criteria: { before: "The definition in `before` (its signature and file), or before correctly says the call cannot be tied to one definition", after: "The definition in `after`, or after correctly says the call cannot be tied to one definition", neither: "Neither candidate; the call invokes something else or the context is not enough to say" } }]));
  const res = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "jev-latest", state, questions }) });
  if (!res.ok) throw new Error(`typesafe ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  return { judged: items.map((it, i) => ({ ...it, jev: body.answers[`e${i}`] })), usage: body.usage ?? { input_tokens: 0, output_tokens: 0 } };
}
try {
  const t0 = Date.now();
  const [bDir, hDir] = [buildAt(base), buildAt(head)];
  const B = dumpEdges(bDir, "base"), H = dumpEdges(hDir, "head");
  const bmap = new Map(B.rows.map((r) => [r.key, r]));
  const changed = [];
  // A reason-only change moves no target, but it is exactly what a classification change does, so it counts.
  for (const h of H.rows) { const b = bmap.get(h.key); if (!b) continue; if ((b.target?.symbol ?? null) !== (h.target?.symbol ?? null) || b.status !== h.status || b.reason !== h.reason) changed.push({ key: h.key, context: H.context[h.key], before: b, after: h }); }
  console.log(`edges base ${B.rows.length} head ${H.rows.length}; files base ${B.files.length} head ${H.files.length}; changed ${changed.length}; build+index ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  const onlyB = B.files.filter((f) => !H.files.includes(f)), onlyH = H.files.filter((f) => !B.files.includes(f)); if (onlyB.length || onlyH.length) console.log("files only in base:", onlyB.slice(0, 5), "only in head:", onlyH.slice(0, 5));
  const hkeys = new Set(H.rows.map((r) => r.key)); const edgesOnlyB = B.rows.filter((r) => !hkeys.has(r.key)), edgesOnlyH = H.rows.filter((r) => !bmap.has(r.key));
  if (edgesOnlyB.length || edgesOnlyH.length) console.log(`edges only in base ${edgesOnlyB.length}, only in head ${edgesOnlyH.length}:`, edgesOnlyB.slice(0, 3).map((r) => r.key), edgesOnlyH.slice(0, 3).map((r) => r.key));
  // lost: a target before and none after; gained: the reverse; moved: a different target on each side.
  const kindOf = (c) => (c.before.target && !c.after.target ? "lost" : !c.before.target && c.after.target ? "gained" : c.before.target && c.after.target ? "moved" : "reclassified");
  const counts = { lost: 0, gained: 0, moved: 0, reclassified: 0 }; for (const c of changed) counts[kindOf(c)] += 1;
  console.log(`lost ${counts.lost} gained ${counts.gained} moved ${counts.moved} reclassified ${counts.reclassified}`);
  if (counts.reclassified > 0) { const by = new Map(); for (const c of changed) if (kindOf(c) === "reclassified") { const k = `${c.before.status}/${c.before.reason} -> ${c.after.status}/${c.after.reason}`; by.set(k, (by.get(k) ?? 0) + 1); } for (const [k, n] of [...by].sort((a, b) => b[1] - a[1])) console.log(`  ${n} ${k}`); }
  const sample = (only ? changed.filter((c) => kindOf(c) === only) : changed).slice(0, limit);
  if (dry || !process.env.TYPESAFE_API_KEY) { for (const c of sample) console.log(`${c.key}: ${c.before.target?.symbol ?? c.before.status + "/" + c.before.reason} -> ${c.after.target?.symbol ?? c.after.status + "/" + c.after.reason}`); if (!dry) console.log("TYPESAFE_API_KEY not set; stopping before Jev."); process.exit(0); }
  const judged = []; let usage = { input_tokens: 0, output_tokens: 0 }; const t1 = Date.now();
  for (let i = 0; i < sample.length; i += 8) { const result = await judge(sample.slice(i, i + 8)); judged.push(...result.judged); usage = { input_tokens: usage.input_tokens + result.usage.input_tokens, output_tokens: usage.output_tokens + result.usage.output_tokens }; }
  const secs = (Date.now() - t1) / 1000;
  const tally = { before: 0, after: 0, neither: 0 };
  for (const j of judged) { tally[j.jev.choice] += 1; const p = j.jev.probabilities?.[j.jev.choice]; console.log(`${j.jev.choice.padEnd(7)} p=${(p ?? 0).toFixed(2)} ${j.key}: ${j.before.target?.symbol ?? j.before.reason} -> ${j.after.target?.symbol ?? j.after.reason}`); }
  console.log(`tally ${JSON.stringify(tally)}; ${judged.length} edges in ${Math.ceil(judged.length / 8)} requests, ${secs.toFixed(1)}s, tokens in ${usage.input_tokens} out ${usage.output_tokens}`);
  if (out) fs.writeFileSync(out, JSON.stringify({ base, head, corpus, measured: new Date().toISOString(), tally, seconds: secs, usage, judged }, null, 2));
} finally {
  cleanup();
}

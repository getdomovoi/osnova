#!/usr/bin/env node
// usage: node scripts/resolution-levers.mjs --corpus <path> [--corpus <path> ...] [--per-reason N] [--dry] [--out file.json]
// Indexes each corpus with this checkout's dist/ and takes a stratified sample of the call edges that stay
// unresolved for a local reason (receiver-unresolved, no-matching-symbol, binding-blocked, bound-symbol-missing;
// import-target-unresolved and unbound-global already count as external). For every sampled edge a System One
// model names the lever that would resolve it (a field type, a return type, a parameter type, an unbounded
// generic, a value with no declaration, a callback, dynamic dispatch, or an external type) and, when the
// index holds same-name candidates, which candidate the call invokes. The tally, scaled by bucket size,
// ranks the levers by the number of call sites each one would move. Review aid only; nothing here touches
// the index, and every verdict is a sample estimate, not a measurement.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const corpora = args.flatMap((a, i) => (a === "--corpus" ? [path.resolve(args[i + 1])] : []));
const perReason = Number(opt("--per-reason", "24")); const dry = args.includes("--dry"); const out = opt("--out");
if (corpora.length === 0) throw new Error("need at least one --corpus");
const LOCAL_REASONS = ["receiver-unresolved", "no-matching-symbol", "binding-blocked", "bound-symbol-missing"];
const LEVERS = {
  "field-type": "The receiver is a field or attribute (self.x, this.x, obj.field) whose type is declared on a struct, class or record in this repository, so following the field declaration would name the type",
  "return-type": "The receiver is the result of a call to a function or method in this repository whose declared return type names a local type",
  "parameter-type": "The receiver is a parameter or local with an explicit type annotation naming a local type, or the callee is a plain name that a local import, module path or alias binds",
  "generic-or-interface": "The receiver is an unbounded type parameter, a trait object, an interface value or an abstract base with several implementations, so one static target does not exist",
  "no-declaration": "The receiver's type is never written down; it would need inference from an expression, an assignment, a destructuring, a loop variable or a literal of a local type",
  "callback": "The callee is a function value: a closure, a callback parameter, a stored function pointer or a method passed by name",
  "dynamic": "The call goes through reflection, getattr, a string name, a macro, a proxy or an eval-like mechanism",
  "external": "The receiver or callee comes from the standard library or a package outside this repository, so no local definition exists",
};
const { buildIndex } = await import(path.join(REPO, "dist", "index.js"));

function collect(index, corpus) {
  const byName = new Map();
  for (const s of index.symbols.values()) { const g = byName.get(s.name) ?? []; g.push(s); byName.set(s.name, g); }
  const lines = (file) => index.files.get(file)?.text.split("\n") ?? [];
  const sig = (s) => ({ symbol: s.qualifiedName, file: s.file, line: s.span.startLine, signature: (lines(s.file)[s.span.startLine - 1] ?? "").trim().slice(0, 160) });
  const rows = [];
  for (const e of index.edges) {
    if (e.kind !== "calls") continue;
    const r = e.evidence?.source === "syntax" ? e.evidence.resolution : undefined;
    if (r?.status !== "unresolved" || !LOCAL_REASONS.includes(r.reason)) continue;
    const t = lines(e.fromFile);
    const context = t.slice(Math.max(0, e.line - 9), e.line).map((l, i) => `${Math.max(1, e.line - 8) + i}: ${l}`).join("\n");
    const candidates = (byName.get(e.toName) ?? []).slice(0, 5).map(sig);
    rows.push({ corpus: path.basename(corpus), language: index.files.get(e.fromFile)?.language ?? "unknown", key: `${e.fromFile}:${e.line} ${e.toName}`, name: e.toName, from: e.fromSymbol, reason: r.reason, binding: e.binding?.kind ?? "none", context, candidates });
  }
  return rows;
}
function stratify(rows) {
  const sample = [];
  for (const reason of LOCAL_REASONS) {
    const bucket = rows.filter((r) => r.reason === reason).sort((a, b) => a.key.localeCompare(b.key));
    if (bucket.length === 0) continue;
    const step = Math.max(1, Math.floor(bucket.length / perReason));
    for (let i = 0; i < bucket.length && sample.filter((r) => r.reason === reason).length < perReason; i += step) sample.push(bucket[i]);
  }
  return sample;
}
async function judge(items) {
  const state = { edges: items.map((it, i) => ({ id: i, language: it.language, callee: it.name, reason: it.reason, context: it.context, candidates: it.candidates.map((c, k) => ({ id: `c${k}`, ...c })) })) };
  const questions = {};
  for (const [i, it] of items.entries()) {
    questions[`lever${i}`] = { type: "choice", instructions: `For \`edges[${i}]\`: the last line of \`edges[${i}].context\` calls \`${it.name}\`, and a syntax-only resolver could not tie the call to a definition in this repository. Which single missing piece of information best explains why, and would resolve the call if the resolver had it?`, criteria: LEVERS };
    if (it.candidates.length > 0) questions[`cand${i}`] = { type: "choice", instructions: `For \`edges[${i}]\`: which of \`edges[${i}].candidates\` does the call on the last context line invoke?`, criteria: { ...Object.fromEntries(it.candidates.map((c, k) => [`c${k}`, `${c.symbol} (${c.file}:${c.line}) ${c.signature}`])), none: "None of the listed candidates, or the context is not enough to say" } };
  }
  const res = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "jev-latest", state, questions }) });
  if (!res.ok) throw new Error(`typesafe ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  return { judged: items.map((it, i) => ({ ...it, lever: body.answers[`lever${i}`], candidate: body.answers[`cand${i}`] ?? null })), usage: body.usage ?? { input_tokens: 0, output_tokens: 0 } };
}

const t0 = Date.now();
const all = [], bucketSizes = {};
for (const corpus of corpora) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-levers-"));
  try {
    const index = await buildIndex(corpus, { cacheDir });
    const rows = collect(index, corpus);
    const name = path.basename(corpus); bucketSizes[name] = {};
    for (const reason of LOCAL_REASONS) bucketSizes[name][reason] = rows.filter((r) => r.reason === reason).length;
    all.push(...stratify(rows));
    console.log(`${name}: local-unresolved ${rows.length} ${JSON.stringify(bucketSizes[name])}`);
  } finally { fs.rmSync(cacheDir, { recursive: true, force: true }); }
}
console.log(`sample ${all.length} edges; index ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (dry || !process.env.TYPESAFE_API_KEY) { for (const r of all) console.log(`${r.reason.padEnd(20)} ${r.binding.padEnd(9)} ${r.key} candidates=${r.candidates.length}`); if (!dry) console.log("TYPESAFE_API_KEY not set; stopping before Jev."); process.exit(0); }
const judged = []; let usage = { input_tokens: 0, output_tokens: 0 }; const t1 = Date.now();
for (let i = 0; i < all.length; i += 8) { const r = await judge(all.slice(i, i + 8)); judged.push(...r.judged); usage = { input_tokens: usage.input_tokens + r.usage.input_tokens, output_tokens: usage.output_tokens + r.usage.output_tokens }; }
const secs = (Date.now() - t1) / 1000;
for (const j of judged) console.log(`${j.lever.choice.padEnd(21)} p=${(j.lever.probabilities?.[j.lever.choice] ?? 0).toFixed(2)} cand=${j.candidate?.choice ?? "-"} ${j.corpus} ${j.reason} ${j.key}`);
// Estimate: for each corpus and reason, share of sampled edges per lever times the bucket size.
const estimate = {};
for (const corpus of Object.keys(bucketSizes)) {
  estimate[corpus] = {};
  for (const reason of LOCAL_REASONS) {
    const rows = judged.filter((j) => j.corpus === corpus && j.reason === reason); if (rows.length === 0) continue;
    for (const lever of Object.keys(LEVERS)) { const n = rows.filter((j) => j.lever.choice === lever).length; if (n > 0) estimate[corpus][lever] = (estimate[corpus][lever] ?? 0) + Math.round((n / rows.length) * bucketSizes[corpus][reason]); }
  }
}
console.log("\nestimated call sites per lever (sample share times bucket size):");
const levers = Object.keys(LEVERS); const corpusNames = Object.keys(estimate);
console.log(["lever", ...corpusNames, "total"].join("\t"));
for (const lever of levers.sort((a, b) => corpusNames.reduce((s, c) => s + (estimate[c][b] ?? 0), 0) - corpusNames.reduce((s, c) => s + (estimate[c][a] ?? 0), 0))) console.log([lever, ...corpusNames.map((c) => estimate[c][lever] ?? 0), corpusNames.reduce((s, c) => s + (estimate[c][lever] ?? 0), 0)].join("\t"));
const withCand = judged.filter((j) => j.candidate); const named = withCand.filter((j) => j.candidate.choice !== "none");
console.log(`\ncandidate named for ${named.length} of ${withCand.length} edges with same-name candidates; ${judged.length} edges in ${Math.ceil(judged.length / 8)} requests, ${secs.toFixed(1)}s, tokens in ${usage.input_tokens} out ${usage.output_tokens}`);
if (out) fs.writeFileSync(out, JSON.stringify({ corpora, measured: new Date().toISOString(), bucketSizes, estimate, seconds: secs, usage, judged }, null, 2));

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { compareArms, loadKiloSession, parseClaudeSession, parseCodexSession, summarizeSession } from "./session-ledger.js";
import type { ArmRow, LedgerHost, SessionSummary } from "./session-ledger.js";

// Session ledger CLI: reads a host's session records (Claude Code JSONL, Codex rollouts, Kilo/OpenCode
// kilo.db) and prints aggregate usage and call classes per session. No command, path, prompt or response
// text is printed. Sessions are keyed by an outcomes-file label when one is given, otherwise by a digest.
const maximumFileBytes = 256 * 1024 * 1024;
const hosts: readonly LedgerHost[] = ["claude-code", "codex", "kilo"];

async function walk(root: string, accept: (file: string) => boolean, found: string[] = []): Promise<string[]> {
  const stat = await fs.lstat(root);
  if (stat.isFile()) { if (accept(root)) found.push(root); return found; }
  if (!stat.isDirectory()) return found;
  for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isSymbolicLink()) continue;
    const next = path.join(root, entry.name);
    if (entry.isDirectory()) await walk(next, accept, found);
    else if (entry.isFile() && accept(next)) found.push(next);
  }
  return found;
}
async function lines(file: string): Promise<string[]> {
  return (await fs.readFile(file, "utf8")).split("\n");
}
// Oversized session files are skipped and counted, so one runaway session cannot stop a whole survey.
async function sized(files: readonly string[], skipped: { count: number }): Promise<string[]> {
  const kept: string[] = [];
  for (const file of files) {
    if ((await fs.stat(file)).size > maximumFileBytes) skipped.count += 1;
    else kept.push(file);
  }
  return kept;
}

interface Outcome { readonly task: string; readonly arm: string; readonly correct: boolean }
function parseOutcomes(raw: unknown): Map<string, Outcome> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("outcomes must be an object keyed by session");
  const outcomes = new Map<string, Outcome>();
  for (const [key, value] of Object.entries(raw)) {
    const item = value as Partial<Outcome>;
    if (typeof item.task !== "string" || typeof item.arm !== "string" || typeof item.correct !== "boolean") throw new Error("each outcome needs task, arm and correct");
    outcomes.set(key, { task: item.task, arm: item.arm, correct: item.correct });
  }
  return outcomes;
}

async function sessions(host: LedgerHost, inputs: readonly string[], skipped: { count: number }): Promise<Map<string, SessionSummary>> {
  const result = new Map<string, SessionSummary>();
  for (const input of inputs) {
    const root = path.resolve(input);
    if (host === "kilo") {
      for (const file of await sized(await walk(root, (name) => path.basename(name) === "kilo.db"), skipped)) result.set(path.relative(root, file) || path.basename(file), summarizeSession(loadKiloSession(file)));
    } else if (host === "codex") {
      for (const file of await sized(await walk(root, (name) => name.endsWith(".jsonl")), skipped)) result.set(path.relative(root, file) || path.basename(file), summarizeSession(parseCodexSession(await lines(file))));
    } else {
      // Subagent transcripts carry their parent's session id, so records group by session id, not by file.
      const grouped = new Map<string, string[]>();
      for (const file of await sized(await walk(root, (name) => name.endsWith(".jsonl")), skipped)) {
        for (const line of await lines(file)) {
          const id = /"sessionId":"([^"]+)"/.exec(line)?.[1] ?? `file:${file}`;
          const list = grouped.get(id) ?? [];
          list.push(line);
          grouped.set(id, list);
        }
      }
      for (const [id, records] of grouped) result.set(id, summarizeSession(parseClaudeSession(records)));
    }
  }
  return result;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    host: { type: "string" }, input: { type: "string", multiple: true }, outcomes: { type: "string" },
    candidate: { type: "string" }, baseline: { type: "string" }, output: { type: "string" },
  } });
  const host = values.host as LedgerHost;
  if (!hosts.includes(host) || values.input === undefined || values.input.length === 0) throw new Error("usage: --host claude-code|codex|kilo --input PATH [--input PATH] [--outcomes FILE --candidate ARM --baseline ARM] [--output FILE]");
  const outcomes = values.outcomes === undefined ? undefined : parseOutcomes(JSON.parse(await fs.readFile(values.outcomes, "utf8")));
  const skipped = { count: 0 };
  const found = await sessions(host, values.input, skipped);
  const rows = [...found].map(([key, summary]) => ({ key, outcome: outcomes?.get(key), summary }));
  const labelled = rows.filter((row): row is typeof row & { outcome: Outcome } => row.outcome !== undefined);
  const report = {
    schemaVersion: 1, mode: "session-ledger", host,
    sessions: rows.map((row) => ({ session: row.outcome === undefined ? createHash("sha256").update(JSON.stringify(row.key)).digest("hex").slice(0, 12) : `${row.outcome.task}:${row.outcome.arm}`, ...(row.outcome === undefined ? {} : { correct: row.outcome.correct }), summary: row.summary }))
      .sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : 0)),
    skippedOversizeFiles: skipped.count,
    unmatchedOutcomes: outcomes === undefined ? 0 : [...outcomes.keys()].filter((key) => !found.has(key)).length,
    comparison: values.candidate !== undefined && values.baseline !== undefined
      ? compareArms(labelled.map((row): ArmRow => ({ task: row.outcome.task, arm: row.outcome.arm, correct: row.outcome.correct, summary: row.summary })), values.candidate, values.baseline)
      : undefined,
    limitations: ["host-reported usage only; null means the host did not report the field", "output includes reasoning; reasoning is the reported part", "Codex input splits cached input from its total; Codex reports no cache writes", "call classes come from tool names and literal shell words, not from what a command read", "grep-after-Osnova matches an identifier search to a name printed by an earlier successful Osnova result"],
  };
  const encoded = JSON.stringify(report, null, 2) + "\n";
  if (values.output === undefined) process.stdout.write(encoded);
  else { await fs.writeFile(values.output, encoded, { flag: "wx" }); process.stdout.write(`ledger report: ${path.resolve(values.output)}\n`); }
}

await main().catch((error: unknown) => {
  process.stderr.write(`ledger failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 2;
});

import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseReplayManifest } from "../scripts/bench/replay-manifest.js";
import { runReplay, compareReplay } from "../scripts/bench/replay.js";
import { auditClaudeTrace } from "../scripts/bench/trace-audit.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => { for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
const fixture = async (): Promise<unknown> => JSON.parse(await fs.readFile(path.join(root, "benchmarks/replay/core-v1.json"), "utf8"));

it("replays incident-shaped operations, preserved answers, source edits and prompt resets", async () => {
  const result = await runReplay(await fixture(), 3);
  expect(result.status).toBe("passed");
  expect(result.summary.failures).toBe(0);
  expect(result.summary.duplicateResponseTokens).toBeGreaterThan(0);
  expect(result.rows.find((r) => r.id === "database-pipeline")?.outcomes).toEqual(["allow", "allow", "allow"]);
  expect(result.rows.find((r) => r.id === "changed-file-revoked")?.outcomes).toEqual(["deny", "deny", "deny"]);
  expect(result.rows.every((r) => new Set(r.responseHashes).size === 1)).toBe(true);
  expect(compareReplay(result, result)).toEqual([]);
  const larger = structuredClone(result);
  larger.rows[0]!.tokens = [1, 1, 1];
  larger.rows[0]!.elapsedMs = [10000, 10000, 10000];
  expect(compareReplay(larger, result)).toEqual(["first-prompt:tokens-increased", "first-prompt:p95-latency"]);
  const wrong = structuredClone(result); wrong.manifestFingerprint = "wrong";
  expect(() => compareReplay(result, wrong)).toThrow(/matching/);
  const changedHarness = structuredClone(result); changedHarness.harnessFingerprint = "changed";
  expect(() => compareReplay(result, changedHarness)).toThrow(/matching/);
  const invalid = structuredClone(result); invalid.rows[0]!.elapsedMs = [NaN, 1, 2];
  expect(() => compareReplay(result, invalid)).toThrow();
});

it("goes red for a missing answer, excess tokens and an incorrectly allowed operation", async () => {
  const manifest = parseReplayManifest(await fixture());
  const query = manifest.steps.find((step) => step.kind === "query")!;
  if (query.kind !== "query") throw new Error("fixture query missing");
  query.required.push("this evidence does not exist"); query.maxTokens = 0;
  const gate = manifest.steps.find((step) => step.id === "status-filter")!;
  if (gate.kind !== "gate") throw new Error("fixture gate missing");
  gate.expected = "deny";
  const result = await runReplay(manifest, 1);
  expect(result.status).toBe("failed");
  expect(result.rows.flatMap((r) => r.failures)).toEqual(expect.arrayContaining(["0:missing-anchor-2", "0:token-budget", "0:expected-deny-got-allow"]));
});

it.each(["../escape.ts", "/tmp/escape.ts", "C:/escape.ts", "src/../../escape.ts", "src\\escape.ts", ".git/config"])("rejects unsafe fixture path %s", async (file) => {
  const manifest = parseReplayManifest(await fixture());
  manifest.files[file] = "bad";
  expect(() => parseReplayManifest(manifest)).toThrow(/unsafe/);
});

it("rejects unknown fields and non-Osnova queries", async () => {
  const manifest = parseReplayManifest(await fixture());
  expect(() => parseReplayManifest({ ...manifest, unknown: true })).toThrow();
  const query = manifest.steps.find((step) => step.kind === "query")!;
  if (query.kind !== "query") throw new Error("fixture query missing");
  query.tool = "execute_command";
  expect(() => parseReplayManifest(manifest)).toThrow(/only Osnova/);
});

it("audits captured calls without executing commands or emitting private content", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-trace-test-")); temporary.push(dir);
  const marker = path.join(dir, "must-not-exist");
  const records = [
    { timestamp: "2026-01-01T00:00:00Z", message: { content: [{ type: "tool_use", id: "private-id", name: "Bash", input: { command: `touch ${marker}` } }] } },
    { timestamp: "2026-01-01T00:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: "private-id", content: "private response", is_error: true }] } },
    { timestamp: "2026-01-01T00:00:02Z", message: { content: [{ type: "tool_use", id: "second-id", name: "Bash", input: { command: `touch ${marker}` } }] } },
    { timestamp: "2026-01-01T00:00:03Z", message: { content: [{ type: "tool_result", tool_use_id: "second-id", content: "private response" }] } },
  ];
  const file = path.join(dir, "trace.jsonl");
  await fs.writeFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\nmalformed\n");
  const report = await auditClaudeTrace(file);
  expect(report).toMatchObject({ toolCalls: 2, repeatedCalls: 1, results: 2, errors: 1, malformedRecords: 1 });
  expect(report.duplicateResponseTokens).toBeGreaterThan(0);
  expect(JSON.stringify(report)).not.toMatch(/private-id|private response|must-not-exist|touch/);
  await expect(fs.stat(marker)).rejects.toThrow();
});

it("CLI saves failing reports, exits nonzero and never overwrites evidence", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-replay-cli-")); temporary.push(dir);
  const manifest = parseReplayManifest(await fixture());
  const step = manifest.steps.find((s) => s.kind === "query")!;
  if (step.kind !== "query") throw new Error("fixture query missing");
  step.required.push("missing evidence");
  const file = path.join(dir, "manifest.json"), output = path.join(dir, "result.json");
  await fs.writeFile(file, JSON.stringify(manifest));
  const args = ["--import", "tsx", path.join(root, "scripts/bench/replay-cli.ts"), "--manifest", file, "--samples", "1", "--output", output];
  await expect(execute(process.execPath, args, { cwd: root })).rejects.toMatchObject({ code: 2 });
  const saved = await fs.readFile(output, "utf8");
  expect(JSON.parse(saved).status).toBe("failed");
  await expect(execute(process.execPath, args, { cwd: root })).rejects.toThrow();
  expect(await fs.readFile(output, "utf8")).toBe(saved);
});

import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { addSession, classifyCall, compareArms, loadKiloSession, parseClaudeSession, parseCodexSession, summarizeSession } from "../scripts/bench/session-ledger.js";

const temporary: string[] = [];
afterEach(async () => { for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
const jsonl = (records: unknown[]): string[] => records.map((record) => JSON.stringify(record));

it("classifies searches, reads, discovery, edits and verification across host tool names", () => {
  expect(classifyCall("Grep", { pattern: "\\bparseTrial\\(" })).toEqual({ kind: "search", identifier: "parseTrial" });
  expect(classifyCall("Bash", { command: "rg -n 'def resolve_name' src" })).toEqual({ kind: "search", identifier: "resolve_name" });
  expect(classifyCall("exec_command", { cmd: ["bash", "-lc", "cd src && grep -rn maskedKeys ."] })).toEqual({ kind: "search", identifier: "maskedKeys" });
  expect(classifyCall("grep", { pattern: "TODO: fix", path: "src" })).toEqual({ kind: "search", identifier: null });
  expect(classifyCall("mcp__osnova__osnova_footing", {}).kind).toBe("osnova");
  expect(classifyCall("mcp__plugin_osnova_osnova__osnova_warp", {}).kind).toBe("osnova");
  expect(classifyCall("osnova_osnova_ground", {}).kind).toBe("osnova");
  expect(classifyCall("Glob", { pattern: "**/*.ts" }).kind).toBe("discovery");
  expect(classifyCall("ls", { path: "src" }).kind).toBe("discovery");
  expect(classifyCall("Bash", { command: "find src -name '*.py'" }).kind).toBe("discovery");
  expect(classifyCall("Read", { file_path: "a.ts" }).kind).toBe("read");
  expect(classifyCall("bash", { command: "sed -n '1,40p' src/a.py" }).kind).toBe("read");
  expect(classifyCall("apply_patch", {}).kind).toBe("edit");
  expect(classifyCall("Bash", { command: "pnpm test -- search" }).kind).toBe("verify");
  expect(classifyCall("shell", { command: ["python", "-m", "pytest", "-q"] }).kind).toBe("verify");
  expect(classifyCall("Bash", { command: "git status --short" }).kind).toBe("shell");
  expect(classifyCall("TodoWrite", {}).kind).toBe("other");
});

it("reads Claude transcripts: one request per message id, sidechains merged, settle continuations and denials counted", () => {
  const usage = { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 40, output_tokens_details: { thinking_tokens: 10 } };
  const session = parseClaudeSession(jsonl([
    { type: "assistant", sessionId: "s", timestamp: "2026-01-01T00:00:00Z", message: { id: "m1", usage, content: [{ type: "thinking" }] } },
    { type: "assistant", sessionId: "s", timestamp: "2026-01-01T00:00:01Z", message: { id: "m1", usage, content: [{ type: "tool_use", id: "t1", name: "mcp__osnova__osnova_footing", input: { question: "x" } }] } },
    { type: "assistant", sessionId: "s", timestamp: "2026-01-01T00:00:01Z", message: { id: "m1", usage, content: [{ type: "tool_use", id: "t2", name: "Grep", input: { pattern: "alpha" } }] } },
    { type: "user", sessionId: "s", timestamp: "2026-01-01T00:00:02Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "osnova generation 1\n- src/a.ts#alpha function" }] }] } },
    { type: "user", sessionId: "s", timestamp: "2026-01-01T00:00:02Z", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "PreToolUse:Grep hook error: osnova gate: blocked", is_error: true }] } },
    { type: "assistant", sessionId: "s", isSidechain: true, timestamp: "2026-01-01T00:00:03Z", message: { id: "m2", usage: { ...usage, cache_creation_input_tokens: 0 }, content: [{ type: "tool_use", id: "t3", name: "Read", input: { file_path: "a.ts" } }] } },
    { type: "system", subtype: "stop_hook_summary", sessionId: "s", timestamp: "2026-01-01T00:00:04Z", hookAdditionalContext: ["[osnova settle] The uncommitted diff touches 3 indexed symbols"] },
    { type: "assistant", sessionId: "s", timestamp: "2026-01-01T00:00:05Z", message: { id: "m3", usage: { ...usage, cache_creation_input_tokens: 0 }, content: [{ type: "tool_use", id: "t4", name: "Grep", input: { pattern: "\\balpha\\b" } }] } },
    "not json",
  ]).map((line) => line === "\"not json\"" ? "not json" : line));
  expect(session.requests.map((request) => request.key)).toEqual(["m1", "m2", "m3"]);
  expect(session.requests[0]!.usage).toEqual({ uncachedInput: 5, cacheRead: 1000, cacheWrite: 100, output: 40, reasoning: 10, costUsd: null });
  expect(session.calls.map((call) => [call.kind, call.outcome])).toEqual([["osnova", "ok"], ["search", "denied"], ["read", "unknown"], ["search", "unknown"]]);
  expect(session.settleContinuations).toBe(1);
  expect(session.malformedRecords).toBe(1);
  const summary = summarizeSession(session);
  expect(summary.requests).toBe(3);
  expect(summary.usage.cacheWrite).toEqual({ total: 100, missing: 0 });
  expect(summary.usage.costUsd).toEqual({ total: null, missing: 3 });
  expect(summary.firstRequestInput).toBe(1105);
  expect(summary).toMatchObject({ denials: 1, settleContinuations: 1, parallelRequests: 1, grepAfterOsnova: 1 });
  expect(JSON.stringify(summary)).not.toMatch(/alpha|a\.ts|osnova gate/);
});

it("reads Codex rollouts: calls belong to the next new token count, cached input is split out, cache writes are unreported", () => {
  const count = (input: number, cached: number, output: number, total: number) => ({ timestamp: "2026-01-01T00:00:01Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 7, total_tokens: input + output }, total_token_usage: { total_tokens: total } } } });
  const session = parseCodexSession(jsonl([
    { timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id: "codex-session" } },
    { timestamp: "2026-01-01T00:00:00Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "rg -n parse_args src"] }), call_id: "c1" } },
    { timestamp: "2026-01-01T00:00:00Z", type: "response_item", payload: { type: "function_call", name: "mcp__osnova__osnova_ground", arguments: "{\"question\":\"parse_args\"}", call_id: "c2" } },
    count(1000, 800, 50, 1050),
    count(1000, 800, 50, 1050),
    { timestamp: "2026-01-01T00:00:02Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: JSON.stringify({ output: "src/a.py:3: def parse_args", metadata: { exit_code: 0 } }) } },
    { timestamp: "2026-01-01T00:00:02Z", type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch", call_id: "c3" } },
    count(1200, 1000, 80, 2330),
  ]));
  expect(session.requests.length).toBe(2);
  expect(session.requests[0]!.usage).toEqual({ uncachedInput: 200, cacheRead: 800, cacheWrite: null, output: 50, reasoning: 7, costUsd: null });
  expect(session.requests[0]!.calls.length).toBe(2);
  expect(session.calls.map((call) => call.kind)).toEqual(["search", "osnova", "edit"]);
  expect(summarizeSession(session).firstRequestInput).toBe(1000);
});

it("reads Codex code-mode items instead of their script wrapper, with reported cache writes", () => {
  const item = (value: Record<string, unknown>) => ({ timestamp: "2026-01-01T00:00:01Z", type: "event_msg", payload: { type: "item_completed", item: value } });
  const tokens = (total: number) => ({ timestamp: "2026-01-01T00:00:02Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 700, cache_write_input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 5 }, total_token_usage: { total_tokens: total } } } });
  const session = parseCodexSession(jsonl([
    { timestamp: "2026-01-01T00:00:00Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "w1", input: "await tools.exec_command({cmd: 'rg alpha'})" } },
    item({ type: "CommandExecution", id: "e1", command: ["/bin/zsh", "-lc", "rg -n alpha src"], exit_code: 1, status: "completed", aggregated_output: "" }),
    item({ type: "McpToolCall", id: "e2", server: "osnova", tool: "osnova_ground", arguments: { question: "alpha" }, status: "completed", result: JSON.stringify({ content: [{ type: "text", text: "osnova generation 1\nsrc/a.ts:1 alpha" }] }) }),
    tokens(1020),
    item({ type: "FileChange", id: "e3", changes: {}, status: "completed" }),
    item({ type: "CommandExecution", id: "e4", command: ["/bin/zsh", "-lc", "rg -n alpha src"], exit_code: 0, status: "completed", aggregated_output: "src/a.ts:1" }),
    item({ type: "HookPrompt", id: "h1", fragments: [{ text: "[osnova settle] The uncommitted diff touches 1 indexed symbols" }] }),
    tokens(2040),
  ]));
  expect(session.calls.map((call) => [call.kind, call.outcome])).toEqual([["search", "error"], ["osnova", "ok"], ["edit", "ok"], ["search", "ok"]]);
  expect(session.requests.map((request) => request.calls.length)).toEqual([2, 2]);
  expect(session.requests[0]!.usage).toEqual({ uncachedInput: 200, cacheRead: 700, cacheWrite: 100, output: 20, reasoning: 5, costUsd: null });
  expect(session.settleContinuations).toBe(1);
  expect(summarizeSession(session).grepAfterOsnova).toBe(1);
});

it("reads a Kilo database read-only and bills reasoning apart from visible output", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-ledger-kilo-")); temporary.push(dir);
  const file = path.join(dir, "kilo.db");
  const db = new DatabaseSync(file);
  db.exec("create table message (id text, data text); create table part (id text, message_id text, data text);");
  const message = db.prepare("insert into message values (?, ?)"), part = db.prepare("insert into part values (?, ?, ?)");
  message.run("u1", JSON.stringify({ role: "user", time: { created: 0 } }));
  message.run("a1", JSON.stringify({ role: "assistant", cost: 0.5, tokens: { input: 10, output: 5, reasoning: 20, cache: { read: 100, write: 0 } }, time: { created: 1000, completed: 2000 } }));
  message.run("a2", JSON.stringify({ role: "assistant", cost: 0.25, tokens: { input: 3, output: 4, reasoning: 0, cache: { read: 130, write: 0 } }, time: { created: 3000, completed: 4000 } }));
  part.run("p1", "a1", JSON.stringify({ type: "tool", tool: "grep", callID: "k1", state: { status: "completed", input: { pattern: "maskedKeys" }, output: "x", time: { start: 1500, end: 1600 } } }));
  part.run("p2", "a2", JSON.stringify({ type: "tool", tool: "bash", callID: "k2", state: { status: "error", input: { command: "rg maskedKeys src" }, error: "failed", time: { start: 3500, end: 3600 } } }));
  db.close();
  const before = await fs.readFile(file);
  const session = loadKiloSession(file);
  expect(await fs.readFile(file)).toEqual(before);
  expect(session.requests.map((request) => request.usage)).toEqual([
    { uncachedInput: 10, cacheRead: 100, cacheWrite: 0, output: 25, reasoning: 20, costUsd: 0.5 },
    { uncachedInput: 3, cacheRead: 130, cacheWrite: 0, output: 4, reasoning: 0, costUsd: 0.25 },
  ]);
  const summary = summarizeSession(session);
  expect(summary).toMatchObject({ requests: 2, elapsedMs: 3000, toolErrors: 1, searchOnlyRequests: 2, repeatedSearchRequests: 1, identifierSearches: 2 });
  expect(summary.usage.costUsd).toEqual({ total: 0.75, missing: 0 });
});

it("reads Kilo rows still held in the write-ahead log without touching the source files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-ledger-kilo-wal-")); temporary.push(dir);
  const file = path.join(dir, "kilo.db");
  const db = new DatabaseSync(file);
  try {
    db.exec("pragma journal_mode = wal; pragma wal_autocheckpoint = 0; create table message (id text, data text); create table part (id text, message_id text, data text);");
    db.exec("pragma wal_checkpoint(truncate)");
    db.prepare("insert into message values (?, ?)").run("a1", JSON.stringify({ role: "assistant", cost: 0.5, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1000, completed: 2000 } }));
    const snapshot = async () => Promise.all((await fs.readdir(dir)).sort().map(async (name) => [name, await fs.readFile(path.join(dir, name))] as const));
    const before = await snapshot();
    expect(before.map(([name]) => name)).toContain("kilo.db-wal");
    const session = loadKiloSession(file);
    expect(session.requests.map((request) => request.usage.costUsd)).toEqual([0.5]);
    expect(await snapshot()).toEqual(before);
  } finally { db.close(); }
});

it("compares arms on correct runs only and keeps excluded pairs visible", () => {
  const row = (task: string, arm: string, correct: boolean, cost: number, elapsedMs: number) => ({ task, arm, correct, summary: { ...summarizeSession({ host: "kilo", requests: [], calls: [], settleContinuations: 0, malformedRecords: 0 }), elapsedMs, usage: { uncachedInput: { total: 1, missing: 0 }, cacheRead: { total: 1, missing: 0 }, cacheWrite: { total: null, missing: 0 }, output: { total: 1, missing: 0 }, reasoning: { total: null, missing: 1 }, costUsd: { total: cost, missing: 0 } } } });
  const report = compareArms([row("t1", "osnova", true, 1, 10), row("t1", "none", true, 2, 30), row("t2", "osnova", false, 1, 10), row("t2", "none", true, 3, 5)], "osnova", "none");
  expect(report.arms.osnova).toMatchObject({ sessions: 2, correct: 1, costPerCorrect: 2 });
  expect(report.arms.none).toMatchObject({ sessions: 2, correct: 2, costPerCorrect: 2.5 });
  expect(report.pairs).toMatchObject({ bothCorrect: 1, excluded: 1, candidateOnly: 0, baselineOnly: 1, candidateCheaper: 1, costDelta: { median: -1 }, elapsedDeltaMs: { median: -20 } });
  expect(() => compareArms([row("t1", "osnova", true, 1, 10), row("t1", "osnova", false, 1, 10), row("t1", "none", true, 2, 30)], "osnova", "none")).toThrow("t1");
});

it("orders Claude requests by time when subagent transcripts are read after the main one", () => {
  const usage = { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 };
  const session = parseClaudeSession(jsonl([
    { type: "assistant", sessionId: "s", timestamp: "2026-01-01T00:00:05Z", message: { id: "late", usage, content: [] } },
    { type: "assistant", sessionId: "s", isSidechain: true, timestamp: "2026-01-01T00:00:01Z", message: { id: "early", usage, content: [] } },
    { type: "assistant", sessionId: "s", timestamp: "2026-01-01T00:00:05Z", message: { id: "tie", usage, content: [] } },
  ]));
  expect(session.requests.map((request) => request.key)).toEqual(["early", "late", "tie"]);
});

it("refuses two sessions with the same key instead of keeping only the last", () => {
  const summary = summarizeSession({ host: "kilo", requests: [], calls: [], settleContinuations: 0, malformedRecords: 0 });
  const sessions = new Map();
  addSession(sessions, "run/kilo.db", summary);
  expect(() => addSession(sessions, "run/kilo.db", summary)).toThrow("run/kilo.db");
  expect(sessions.size).toBe(1);
});

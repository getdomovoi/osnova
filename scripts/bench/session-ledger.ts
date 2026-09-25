import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseSearchCall, shellPipelines } from "./shell-search.js";

// A session ledger: provider-reported usage per model request and a class for every tool call, read from
// a host's own session record. It measures where a finished session spent its requests; it never runs a
// recorded command and never estimates a usage field the host did not report.
export type LedgerHost = "claude-code" | "codex" | "kilo";
export type CallKind = "osnova" | "search" | "discovery" | "read" | "edit" | "verify" | "shell" | "other";
export const callKinds: readonly CallKind[] = ["osnova", "search", "discovery", "read", "edit", "verify", "shell", "other"];

/** Billed categories. `output` includes reasoning; `reasoning` is the reported part of it. Null: not reported. */
export interface LedgerUsage {
  readonly uncachedInput: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly output: number | null;
  readonly reasoning: number | null;
  readonly costUsd: number | null;
}
export interface LedgerRequest { readonly key: string; readonly startMs: number | null; readonly endMs: number | null; readonly usage: LedgerUsage; readonly calls: readonly string[] }
export interface LedgerCall {
  readonly key: string;
  readonly tool: string;
  readonly kind: CallKind;
  readonly identifier: string | null;
  outcome: "ok" | "error" | "denied" | "unknown";
  /** Response text, kept in memory for grep-after-Osnova detection; never reported. */
  output: string;
}
export interface LedgerSession {
  readonly host: LedgerHost;
  readonly requests: readonly LedgerRequest[];
  readonly calls: readonly LedgerCall[];
  readonly settleContinuations: number;
  readonly malformedRecords: number;
}

const osnovaTool = /(?:^|__|_|:|\.)osnova_(?:ground|thread|outline|warp|groundwork|footing|settle|plumb|tests|unreferenced)$/;
const readTools = new Set(["read", "read_file", "readfile", "view", "notebookread", "read_text_file"]);
const editTools = new Set(["edit", "write", "multiedit", "notebookedit", "apply_patch", "patch", "str_replace_based_edit_tool", "create_file"]);
const searchTools = new Set(["grep", "search", "codebase_search", "grep_search", "grep_files", "rg"]);
const discoveryTools = new Set(["glob", "find", "list", "ls", "list_dir", "list_directory", "file_search"]);
const shellTools = new Set(["bash", "shell", "shell_command", "exec_command", "execute_command", "run_terminal_cmd", "local_shell"]);
const verifyCommand = /(?:^|[\s;&|(])(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check)\b|npx\s+(?:vitest|jest|tsc)\b|vitest\b|jest\b|pytest\b|python3?\s+-m\s+(?:pytest|unittest)\b|go\s+(?:test|build|vet)\b|cargo\s+(?:test|build|check|clippy)\b|tsc\b|make\s+(?:test|check)\b|tox\b|\.\/runtests\.py|bin\/test\b)/;
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The one name a search pattern asks for: a bare identifier, a call (`name(`), a word-bounded name or a
// definition search (`def name`, `class Name`). Anything else is a text search a graph answer cannot replace.
function searchedName(pattern: string | undefined): string | null {
  if (pattern === undefined) return null;
  const definition = /^(?:def|class|function|fn|func|interface|type|struct|trait|enum|const|let|var)\s+([A-Za-z_]\w*)\W*$/.exec(pattern.trim());
  const bare = (definition?.[1] ?? pattern).replace(/^\\b|\\b$/g, "").replace(/^\^|\$$/g, "").replace(/^(?:\\\.|\.)/, "").replace(/(?:\\\(|\()$/, "");
  return bare.length >= 3 && identifier.test(bare) ? bare : null;
}

function commandText(input: Readonly<Record<string, unknown>>): string {
  const raw = input.command ?? input.cmd;
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw) || !raw.every((word) => typeof word === "string")) return "";
  const words = raw as string[];
  if (words.length === 3 && /^(?:ba|z|da)?sh$/.test(words[0]!.split("/").at(-1)!) && /^-l?c$/.test(words[1]!)) return words[2]!;
  return words.map((word) => (/^[\w./:=@%+-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`)).join(" ");
}

function firstCommands(command: string): (readonly string[])[] {
  const parsed = shellPipelines(command);
  if (parsed !== null) return parsed.map((pipeline) => pipeline[0] ?? []).filter((words) => words.length > 0 && words[0] !== "cd");
  return command.split(/&&|\|\||;|\n/).map((part) => part.trim().split(/\s+/)).filter((words) => words[0] !== undefined && words[0] !== "" && words[0] !== "cd");
}

export function classifyCall(tool: string, input: Readonly<Record<string, unknown>>): { kind: CallKind; identifier: string | null } {
  if (osnovaTool.test(tool)) return { kind: "osnova", identifier: null };
  const name = tool.split("__").at(-1)!.toLowerCase();
  if (readTools.has(name)) return { kind: "read", identifier: null };
  if (editTools.has(name)) return { kind: "edit", identifier: null };
  if (searchTools.has(name)) return { kind: "search", identifier: searchedName(typeof input.pattern === "string" ? input.pattern : typeof input.query === "string" ? input.query : undefined) };
  if (discoveryTools.has(name)) return { kind: "discovery", identifier: null };
  if (!shellTools.has(name)) return { kind: "other", identifier: null };
  const command = commandText(input);
  const search = parseSearchCall("Bash", { command });
  if (search !== null) return { kind: "search", identifier: search.patterns.length === 1 ? searchedName(search.patterns[0]) : null };
  if (verifyCommand.test(command)) return { kind: "verify", identifier: null };
  const commands = firstCommands(command);
  const programs = commands.map((words) => words[0]!.split("/").at(-1)!);
  if (programs.some((program) => ["rg", "grep", "egrep", "fgrep", "ag", "ack"].includes(program))) return { kind: "search", identifier: null };
  if (programs.some((program, i) => ["find", "fd", "ls", "tree"].includes(program) || program === "git" && commands[i]![1] === "ls-files")) return { kind: "discovery", identifier: null };
  if (programs.length > 0 && programs.every((program, i) => ["cat", "head", "tail", "nl", "less", "bat"].includes(program) || program === "sed" && commands[i]![1] === "-n")) return { kind: "read", identifier: null };
  return { kind: "shell", identifier: null };
}

const deniedText = /osnova gate:|osnova-first:/;
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return textOf(record.text ?? record.content ?? record.output ?? "");
  }
  return "";
}
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const larger = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));
const timeOf = (value: unknown): number | null => {
  const parsed = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function makeCall(key: string, tool: string, input: unknown): LedgerCall {
  const args = input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  return { key, tool, ...classifyCall(tool, args), outcome: "unknown", output: "" };
}
function settle(call: LedgerCall | undefined, output: string, error: boolean): void {
  if (call === undefined) return;
  call.output = output;
  call.outcome = deniedText.test(output) ? "denied" : error ? "error" : "ok";
}

// Claude Code writes one record per content block, each repeating the message's usage; a subagent's
// records carry the parent session id. Usage fields are taken as the maximum seen per message id.
export function parseClaudeSession(lines: Iterable<string>): LedgerSession {
  const requests = new Map<string, { startMs: number | null; endMs: number | null; usage: LedgerUsage; calls: string[] }>();
  const calls = new Map<string, LedgerCall>();
  let malformedRecords = 0, settleContinuations = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const record = parseLine(line);
    if (record === null) { malformedRecords += 1; continue; }
    const at = timeOf(record.timestamp);
    if (record.type === "system" && record.subtype === "stop_hook_summary") {
      const context = Array.isArray(record.hookAdditionalContext) ? record.hookAdditionalContext : [];
      if (context.some((text) => typeof text === "string" && text.includes("[osnova settle]"))) settleContinuations += 1;
      continue;
    }
    const message = record.message as { id?: unknown; usage?: Record<string, unknown>; content?: unknown } | undefined;
    if (message === undefined || !Array.isArray(message.content)) continue;
    if (record.type === "assistant" && typeof message.id === "string") {
      const usage = message.usage ?? {};
      const details = usage.output_tokens_details as Record<string, unknown> | undefined;
      const next: LedgerUsage = { uncachedInput: count(usage.input_tokens), cacheRead: count(usage.cache_read_input_tokens), cacheWrite: count(usage.cache_creation_input_tokens), output: count(usage.output_tokens), reasoning: count(details?.thinking_tokens), costUsd: null };
      const current = requests.get(message.id);
      const merged = current === undefined ? next : {
        uncachedInput: larger(current.usage.uncachedInput, next.uncachedInput), cacheRead: larger(current.usage.cacheRead, next.cacheRead), cacheWrite: larger(current.usage.cacheWrite, next.cacheWrite),
        output: larger(current.usage.output, next.output), reasoning: larger(current.usage.reasoning, next.reasoning), costUsd: null,
      };
      const entry = current ?? { startMs: at, endMs: at, usage: merged, calls: [] };
      entry.usage = merged;
      entry.endMs = larger(entry.endMs, at);
      for (const block of message.content as Record<string, unknown>[]) {
        if (block?.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string" || calls.has(block.id)) continue;
        calls.set(block.id, makeCall(block.id, block.name, block.input));
        entry.calls.push(block.id);
      }
      requests.set(message.id, entry);
    } else if (record.type === "user") {
      for (const block of message.content as Record<string, unknown>[]) {
        if (block?.type === "tool_result" && typeof block.tool_use_id === "string") settle(calls.get(block.tool_use_id), textOf(block.content), block.is_error === true);
      }
    }
  }
  return { host: "claude-code", requests: [...requests].map(([key, value]) => ({ key, ...value })), calls: [...calls.values()], settleContinuations, malformedRecords };
}

// Code-mode wrappers run a script that issues the real operations; Codex reports those as completed items.
const codexWrappers = new Set(["exec", "js"]);

// Codex emits a token_count event after each model response; the tool calls it issued, and the items they
// completed, precede it. A repeated event with an unchanged running total is the same request. input_tokens
// includes cached input; cache writes are reported only by versions that emit cache_write_input_tokens.
export function parseCodexSession(lines: Iterable<string>): LedgerSession {
  const requests: LedgerRequest[] = [];
  const calls = new Map<string, LedgerCall>();
  let pending: string[] = [], started: number | null = null, lastTotal: unknown, malformedRecords = 0, settleContinuations = 0;
  const add = (call: LedgerCall): void => { if (!calls.has(call.key)) pending.push(call.key); calls.set(call.key, call); };
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const record = parseLine(line);
    if (record === null) { malformedRecords += 1; continue; }
    const at = timeOf(record.timestamp);
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    if (record.type === "event_msg" && payload.type === "token_count") {
      const info = payload.info as { last_token_usage?: Record<string, unknown>; total_token_usage?: Record<string, unknown> } | null | undefined;
      const last = info?.last_token_usage;
      const total = JSON.stringify(info?.total_token_usage ?? null);
      if (last === undefined || total === lastTotal) continue;
      lastTotal = total;
      const input = count(last.input_tokens), cached = count(last.cached_input_tokens), written = count(last.cache_write_input_tokens);
      requests.push({ key: `r${requests.length + 1}`, startMs: started ?? at, endMs: at, calls: pending,
        usage: { uncachedInput: input === null ? null : Math.max(0, input - (cached ?? 0) - (written ?? 0)), cacheRead: cached, cacheWrite: written, output: count(last.output_tokens), reasoning: count(last.reasoning_output_tokens), costUsd: null } });
      pending = []; started = null;
      continue;
    }
    if (record.type === "event_msg" && payload.type === "item_completed") {
      const item = (payload.item ?? {}) as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id : undefined;
      if (id === undefined) continue;
      started ??= at;
      if (item.type === "CommandExecution") {
        const call = calls.get(id) ?? makeCall(id, "exec_command", { command: item.command });
        add(call);
        settle(call, textOf(item.aggregated_output), typeof item.exit_code === "number" && item.exit_code !== 0 || item.status === "failed");
      } else if (item.type === "FileChange") {
        const call = calls.get(id) ?? makeCall(id, "apply_patch", {});
        add(call);
        settle(call, "", item.status === "failed");
      } else if (item.type === "McpToolCall" && typeof item.tool === "string") {
        const call = calls.get(id) ?? makeCall(id, `mcp__${String(item.server)}__${item.tool}`, item.arguments);
        add(call);
        const result = typeof item.result === "string" ? parseLine(item.result) ?? item.result : item.result;
        settle(call, textOf(result), item.status === "failed" || (result as Record<string, unknown> | null)?.isError === true || item.error !== undefined && item.error !== null);
      } else if (item.type === "HookPrompt" && textOf(item.fragments).includes("[osnova settle]")) settleContinuations += 1;
      continue;
    }
    if (record.type !== "response_item") continue;
    started ??= at;
    const id = typeof payload.call_id === "string" ? payload.call_id : undefined;
    if ((payload.type === "function_call" || payload.type === "custom_tool_call" || payload.type === "local_shell_call") && id !== undefined && !calls.has(id)) {
      if (typeof payload.name === "string" && codexWrappers.has(payload.name)) continue;
      let input: unknown = payload.type === "custom_tool_call" ? { input: payload.input } : payload.type === "local_shell_call" ? (payload.action as Record<string, unknown> | undefined) : payload.arguments;
      if (typeof input === "string") input = parseLine(input) ?? {};
      add(makeCall(id, typeof payload.name === "string" ? payload.name : "local_shell", input));
    } else if ((payload.type === "function_call_output" || payload.type === "custom_tool_call_output") && id !== undefined) {
      const raw = payload.output;
      const parsed = typeof raw === "string" ? parseLine(raw) : null;
      const exit = (parsed?.metadata as Record<string, unknown> | undefined)?.exit_code;
      settle(calls.get(id), textOf(parsed ?? raw), typeof exit === "number" && exit !== 0);
    } else if (payload.type === "message" && textOf(payload.content).includes("[osnova settle]")) settleContinuations += 1;
  }
  return { host: "codex", requests, calls: [...calls.values()], settleContinuations, malformedRecords };
}

// Kilo and OpenCode keep sessions in SQLite: assistant messages carry tokens (input excludes cache reads,
// output excludes reasoning) and cost; tool parts carry the call. The file is opened immutable, never written.
export function loadKiloSession(file: string): LedgerSession {
  const url = pathToFileURL(file);
  url.searchParams.set("immutable", "1");
  const db = new DatabaseSync(url, { readOnly: true });
  try {
    const rows = (sql: string) => db.prepare(sql).all() as { id: string; message_id?: string; data: string }[];
    const messages = rows("select id, data from message").map((row) => ({ id: row.id, data: parseLine(row.data) ?? {} }));
    const parts = rows("select id, message_id, data from part").map((row) => ({ messageId: row.message_id ?? "", data: parseLine(row.data) ?? {} }));
    const time = (data: Record<string, unknown>, key: string): number | null => count((data.time as Record<string, unknown> | undefined)?.[key]);
    const assistant = messages.filter((message) => message.data.role === "assistant" && message.data.tokens !== undefined)
      .sort((a, b) => (time(a.data, "created") ?? 0) - (time(b.data, "created") ?? 0) || (a.id < b.id ? -1 : 1));
    const calls: LedgerCall[] = [];
    const byMessage = new Map<string, string[]>();
    const tools = parts.filter((part) => part.data.type === "tool")
      .sort((a, b) => (time((a.data.state ?? {}) as Record<string, unknown>, "start") ?? 0) - (time((b.data.state ?? {}) as Record<string, unknown>, "start") ?? 0));
    for (const [position, part] of tools.entries()) {
      const state = (part.data.state ?? {}) as Record<string, unknown>;
      const key = typeof part.data.callID === "string" ? part.data.callID : `call-${position}`;
      const call = makeCall(key, typeof part.data.tool === "string" ? part.data.tool : "unknown", state.input);
      if (state.status === "completed" || state.status === "error") settle(call, textOf(state.output ?? state.error ?? ""), state.status === "error");
      calls.push(call);
      byMessage.set(part.messageId, [...(byMessage.get(part.messageId) ?? []), key]);
    }
    const requests = assistant.map((message): LedgerRequest => {
      const tokens = message.data.tokens as Record<string, unknown>;
      const cache = (tokens.cache ?? {}) as Record<string, unknown>;
      const output = count(tokens.output), reasoning = count(tokens.reasoning);
      return { key: message.id, startMs: time(message.data, "created"), endMs: time(message.data, "completed") ?? time(message.data, "created"), calls: byMessage.get(message.id) ?? [],
        usage: { uncachedInput: count(tokens.input), cacheRead: count(cache.read), cacheWrite: count(cache.write), output: output === null ? null : output + (reasoning ?? 0), reasoning, costUsd: count(message.data.cost) } };
    });
    return { host: "kilo", requests, calls, settleContinuations: 0, malformedRecords: 0 };
  } finally { db.close(); }
}

export interface Sum { readonly total: number | null; readonly missing: number }
export type UsageSums = { readonly [K in keyof LedgerUsage]: Sum };
export interface SessionSummary {
  readonly host: LedgerHost;
  readonly requests: number;
  readonly elapsedMs: number | null;
  readonly usage: UsageSums;
  /** Everything the first request read: uncached input plus reported cache reads and writes. */
  readonly firstRequestInput: number | null;
  readonly calls: Readonly<Record<CallKind, number>>;
  readonly parallelRequests: number;
  readonly searchOnlyRequests: number;
  /** Search-only requests that directly follow another search-only request: a search that had to be retried or refined. */
  readonly repeatedSearchRequests: number;
  readonly searchOnlyInput: number | null;
  readonly identifierSearches: number;
  readonly grepAfterOsnova: number;
  readonly denials: number;
  readonly toolErrors: number;
  /** Failed calls per call class, and calls and failures per Osnova tool (by its bare contract name). */
  readonly errorsByKind: Readonly<Record<CallKind, number>>;
  readonly osnovaTools: Readonly<Record<string, { readonly calls: number; readonly errors: number }>>;
  readonly settleContinuations: number;
  readonly malformedRecords: number;
}

function osnovaToolCounts(calls: readonly LedgerCall[]): Record<string, { calls: number; errors: number }> {
  const counts: Record<string, { calls: number; errors: number }> = {};
  for (const call of calls) {
    const name = call.kind === "osnova" ? /osnova_[a-z]+$/.exec(call.tool)?.[0] : undefined;
    if (name === undefined) continue;
    const entry = counts[name] ??= { calls: 0, errors: 0 };
    entry.calls += 1;
    if (call.outcome === "error") entry.errors += 1;
  }
  return counts;
}
function addCounts(rows: readonly ArmRow[]): Record<string, { calls: number; errors: number }> {
  const total: Record<string, { calls: number; errors: number }> = {};
  for (const row of rows) {
    for (const [name, value] of Object.entries(row.summary.osnovaTools)) {
      const entry = total[name] ??= { calls: 0, errors: 0 };
      entry.calls += value.calls;
      entry.errors += value.errors;
    }
  }
  return total;
}
const inputOf = (usage: LedgerUsage): number | null => (usage.uncachedInput === null ? null : usage.uncachedInput + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0));
function sum(values: readonly (number | null)[]): Sum {
  const present = values.filter((value): value is number => value !== null);
  return { total: present.length === 0 ? null : present.reduce((a, b) => a + b, 0), missing: values.length - present.length };
}

export function summarizeSession(session: LedgerSession): SessionSummary {
  const byKey = new Map(session.calls.map((call) => [call.key, call]));
  const usage = Object.fromEntries((["uncachedInput", "cacheRead", "cacheWrite", "output", "reasoning", "costUsd"] as const)
    .map((key) => [key, sum(session.requests.map((request) => request.usage[key]))])) as unknown as UsageSums;
  const calls = Object.fromEntries(callKinds.map((kind) => [kind, session.calls.filter((call) => call.kind === kind).length])) as Record<CallKind, number>;
  const searchOnly = session.requests.map((request) => request.calls.length > 0 && request.calls.every((key) => ["search", "discovery"].includes(byKey.get(key)?.kind ?? "")));
  const named = new Set<string>();
  let grepAfterOsnova = 0;
  for (const request of session.requests) {
    for (const key of request.calls) {
      const call = byKey.get(key);
      if (call?.kind === "search" && call.identifier !== null && named.has(call.identifier)) grepAfterOsnova += 1;
    }
    for (const key of request.calls) {
      const call = byKey.get(key);
      if (call?.kind === "osnova" && call.outcome === "ok") for (const token of call.output.slice(0, 200_000).match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) named.add(token);
    }
  }
  const starts = session.requests.map((request) => request.startMs).filter((value): value is number => value !== null);
  const ends = session.requests.map((request) => request.endMs).filter((value): value is number => value !== null);
  return {
    host: session.host,
    requests: session.requests.length,
    elapsedMs: starts.length === 0 || ends.length === 0 ? null : Math.max(...ends) - Math.min(...starts),
    usage,
    firstRequestInput: session.requests[0] === undefined ? null : inputOf(session.requests[0].usage),
    calls,
    parallelRequests: session.requests.filter((request) => request.calls.length > 1).length,
    searchOnlyRequests: searchOnly.filter(Boolean).length,
    repeatedSearchRequests: searchOnly.filter((value, i) => value && i > 0 && searchOnly[i - 1]).length,
    searchOnlyInput: sum(session.requests.filter((_, i) => searchOnly[i]).map((request) => inputOf(request.usage))).total,
    identifierSearches: session.calls.filter((call) => call.kind === "search" && call.identifier !== null).length,
    grepAfterOsnova,
    denials: session.calls.filter((call) => call.outcome === "denied").length,
    toolErrors: session.calls.filter((call) => call.outcome === "error").length,
    errorsByKind: Object.fromEntries(callKinds.map((kind) => [kind, session.calls.filter((call) => call.kind === kind && call.outcome === "error").length])) as Record<CallKind, number>,
    osnovaTools: osnovaToolCounts(session.calls),
    settleContinuations: session.settleContinuations,
    malformedRecords: session.malformedRecords,
  };
}

export interface ArmRow { readonly task: string; readonly arm: string; readonly correct: boolean; readonly summary: SessionSummary }
const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const totalTokens = (summary: SessionSummary): number | null => {
  const { uncachedInput, cacheRead, cacheWrite, output } = summary.usage;
  return uncachedInput.total === null || output.total === null ? null : uncachedInput.total + (cacheRead.total ?? 0) + (cacheWrite.total ?? 0) + output.total;
};

// Primary outcome: cost and time per correct session. Paired deltas use only tasks both arms solved;
// every other pair is counted as excluded, never dropped silently. A missing cost stays missing.
export function compareArms(rows: readonly ArmRow[], candidate: string, baseline: string) {
  const arm = (name: string) => {
    const all = rows.filter((row) => row.arm === name), correct = all.filter((row) => row.correct);
    // Spend on failed sessions counts: the cost of a solved task includes the attempts that did not solve it.
    const perCorrect = (values: readonly (number | null)[]): number | null => (correct.length === 0 || values.some((value) => value === null) ? null : values.reduce<number>((a, b) => a + b!, 0) / correct.length);
    return {
      sessions: all.length, correct: correct.length,
      costPerCorrect: perCorrect(all.map((row) => row.summary.usage.costUsd.total)),
      elapsedMsPerCorrect: perCorrect(all.map((row) => row.summary.elapsedMs)),
      tokensPerCorrect: perCorrect(all.map((row) => totalTokens(row.summary))),
      totalCost: sum(all.map((row) => row.summary.usage.costUsd.total)),
      explanatory: Object.fromEntries((["requests", "searchOnlyRequests", "repeatedSearchRequests", "identifierSearches", "grepAfterOsnova", "denials", "toolErrors", "settleContinuations", "parallelRequests"] as const)
        .map((key) => [key, all.reduce((total, row) => total + row.summary[key], 0)])),
      calls: Object.fromEntries(callKinds.map((kind) => [kind, all.reduce((total, row) => total + row.summary.calls[kind], 0)])),
      errorsByKind: Object.fromEntries(callKinds.map((kind) => [kind, all.reduce((total, row) => total + row.summary.errorsByKind[kind], 0)])),
      osnovaTools: addCounts(all),
      medianFirstRequestInput: median(all.map((row) => row.summary.firstRequestInput).filter((value): value is number => value !== null)),
    };
  };
  const tasks = [...new Set(rows.map((row) => row.task))].sort();
  const find = (task: string, name: string) => rows.find((row) => row.task === task && row.arm === name);
  let bothCorrect = 0, excluded = 0, candidateOnly = 0, baselineOnly = 0, candidateCheaper = 0;
  const costDeltas: number[] = [], elapsedDeltas: number[] = [], tokenDeltas: number[] = [];
  for (const task of tasks) {
    const a = find(task, candidate), b = find(task, baseline);
    if (a === undefined || b === undefined) { excluded += 1; continue; }
    if (a.correct && !b.correct) candidateOnly += 1;
    if (!a.correct && b.correct) baselineOnly += 1;
    if (!a.correct || !b.correct) { excluded += 1; continue; }
    bothCorrect += 1;
    const costA = a.summary.usage.costUsd.total, costB = b.summary.usage.costUsd.total;
    const timeA = a.summary.elapsedMs, timeB = b.summary.elapsedMs, tokensA = totalTokens(a.summary), tokensB = totalTokens(b.summary);
    if (costA !== null && costB !== null) { costDeltas.push(costA - costB); if (costA < costB) candidateCheaper += 1; }
    if (timeA !== null && timeB !== null) elapsedDeltas.push(timeA - timeB);
    if (tokensA !== null && tokensB !== null) tokenDeltas.push(tokensA - tokensB);
  }
  const spread = (values: readonly number[]) => ({ samples: values.length, median: median(values), total: values.reduce((a, b) => a + b, 0) });
  return {
    candidate, baseline,
    arms: { [candidate]: arm(candidate), [baseline]: arm(baseline) },
    pairs: { tasks: tasks.length, bothCorrect, excluded, candidateOnly, baselineOnly, candidateCheaper, costDelta: spread(costDeltas), elapsedDeltaMs: spread(elapsedDeltas), tokenDelta: spread(tokenDeltas) },
    interpretation: "cost and time per correct session are primary; paired deltas cover tasks both arms solved; call and request counts explain, they are not savings; null means the host did not report the field",
  };
}

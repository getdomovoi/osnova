import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { promises as fs } from "node:fs";
import { loadIndex, refreshWorkspace } from "../api.js";
import { resolveCacheDir } from "../cache/cache.js";
import { taskContext } from "../query/task-context.js";
import { impact } from "../query/impact.js";
import { findTextDetailed } from "../query/findText.js";
import { boundText } from "../query/budget.js";
import type { TaskContextResult } from "../query/task-context.js";
import type { ImpactResult } from "../query/impact.js";
import type { OsnovaIndex, OsnovaSymbol } from "../types.js";
import type { CliIo } from "./cli.js";
import { parseSearchCall, searchRegExp, symbolHuntNames } from "./search-guard.js";
import { existsSync, statSync } from "node:fs";

// Editor hooks: a session hook prints the index size and one pointer to the tools (the MCP server's
// `instructions` carry the contract; `--full-contract` restates it for a harness without MCP), a prompt
// hook prints starting points for the prompt, a stop hook hands the agent the dependents of its
// uncommitted diff before it finishes.
// All read the hook payload from stdin, never touch repository files, and exit 0 on every failure
// so a hook can never block a prompt. A repository with no cache yet is indexed in the background
// from the session hook; the prompt and stop hooks answer only from an existing cache.
// The stop hook continues the turn at most once per diff per session, and only when the dependents
// outnumber OSNOVA_HOOK_SETTLE_BLOCK_AT (default 1); otherwise it warns the user without continuing.
// Its once-per-diff and once-per-nudge state lives under the cache directory, the one place the
// hooks may write.
export type HookEvent = "prompt" | "session" | "stop" | "tool" | "search" | "install-preview";
export const hookEvents: readonly HookEvent[] = ["prompt", "session", "stop", "tool", "search", "install-preview"];
export function isHookEvent(value: unknown): value is HookEvent { return (hookEvents as readonly unknown[]).includes(value); }
export const hookPromptCodeUnits = 1_024;
export const hookSessionCodeUnits = 1_536;
export const hookStopCodeUnits = 1_536;
/** The longest complete answer the search hook gives; above it the search runs. */
export const hookSearchCodeUnits = 8_192;
/** A name with more definitions than this is too generic for a graph answer; the search runs. */
const searchMaximumDefinitions = 5;
const minimumPromptLength = 12;
const maximumDiffBytes = 4 * 1024 * 1024;
const defaultSettleContinueThreshold = 1;
const execFileAsync = promisify(execFile);

export function hookFileDescription(client: HookClient): string {
  return client === "codex" ? "~/.codex/hooks.json" : client === "cursor" ? "~/.cursor/hooks.json" : "~/.claude/settings.json";
}

export interface HookInput {
  readonly prompt?: string | undefined;
  readonly cwd?: string | undefined;
  readonly stopHookActive?: boolean | undefined;
  readonly sessionId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly toolInput?: Readonly<Record<string, unknown>> | undefined;
}

export const hookToolContract = [
  "[osnova] This repository is indexed by Osnova: a deterministic call graph with exact file:line, no type inference, no LLM. Use its tools for relationship questions: who calls a symbol, what a change affects, which tests reach it, what is unused, which handler serves a route. One answer replaces a chain of grep and file reads. To find a string, plain rg is smaller than osnova_thread. Tools:",
  "- osnova_footing: task context for a question or named symbols (definitions, callers, candidate tests). Start here when a task spans several files.",
  "- osnova_ground: symbol and text search ranked by definition evidence; a verb and path (GET /users) finds the route and its handler.",
  "- osnova_thread: exhaustive regex search grouped by enclosing symbol.",
  "- osnova_outline: one file's signatures and spans.",
  "- osnova_warp: callers or callees of one symbol, direct or transitive, with the resolution basis of every edge; unresolved edges list same-name candidates.",
  "- osnova_groundwork: repository map, hubs and hotspots.",
  "- osnova_settle: dependents of your uncommitted changes (no arguments) before you finish a change.",
  "- osnova_plumb: check a claimed list of call sites against the index.",
  "An answer that says a symbol has no indexed callers is not proof of absence; an unresolved edge is a lead, not a relationship.",
].join("\n");

const hookSessionPointer = "use osnova_* for callers, impact, tests, unused code (osnova_footing for multi-file tasks); rg is fine for a string.";
export function formatSessionContext(status: string, fullContract: boolean): string {
  return fullContract ? `${hookToolContract}\n${status}` : `[osnova] ${status.replace(/\.$/, "")}; ${hookSessionPointer}`;
}

export function parseHookInput(raw: string): HookInput {
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (typeof parsed !== "object" || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  return {
    prompt: typeof record.prompt === "string" ? record.prompt : undefined,
    cwd: typeof record.cwd === "string" ? record.cwd : undefined,
    stopHookActive: typeof record.stop_hook_active === "boolean" ? record.stop_hook_active : undefined,
    sessionId: typeof record.session_id === "string" ? record.session_id : typeof record.conversation_id === "string" ? record.conversation_id : undefined,
    toolName: typeof record.tool_name === "string" ? record.tool_name : undefined,
    toolInput: record.tool_input !== null && typeof record.tool_input === "object" && !Array.isArray(record.tool_input) ? (record.tool_input as Record<string, unknown>) : undefined,
  };
}

// The repository root for a directory: the git top level when there is one, the directory otherwise.
export function workspaceRootFor(dir: string): string {
  try {
    const top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    // git prints forward slashes everywhere; resolve() gives the platform's form.
    return top.length > 0 ? path.resolve(top) : path.resolve(dir);
  } catch { return path.resolve(dir); }
}

export function hookSettingsSnippet(command: readonly string[], client: HookClient = "claude-code", nudge = false): string {
  return JSON.stringify(hookSettingsObject(command, client, nudge), null, 2);
}

// The hook groups a client's file needs. Claude Code and Codex share one shape; Cursor's beforeSubmitPrompt cannot add context,
// so Cursor gets the stop hook only, as a follow-up message.
// The PostToolUse grep nudge is opt-in (`nudge`): measured, it did not change what the agent did after a grep.
export function hookSettingsObject(command: readonly string[], client: HookClient, nudge = false): Record<string, unknown> {
  const quoted = command.map((part) => (/[\s"]/.test(part) ? JSON.stringify(part) : part)).join(" ");
  const suffix = client === "claude-code" ? "" : ` --client ${client}`;
  if (client === "cursor") return { version: 1, hooks: { stop: [{ command: `${quoted} hook stop${suffix}`, timeout: 30 }] } };
  const entry = (event: HookEvent, timeout: number) => ({ hooks: [{ type: "command", command: `${quoted} hook ${event}${suffix}`, timeout }] });
  const hooks: Record<string, unknown[]> = { SessionStart: [entry("session", 15)], UserPromptSubmit: [entry("prompt", 15)], Stop: [entry("stop", 30)] };
  if (client === "claude-code") hooks.PreToolUse = [{ matcher: "Grep|Bash", ...entry("search", 10) }];
  if (client === "claude-code" && nudge) hooks.PostToolUse = [{ matcher: "Grep|Bash", ...entry("tool", 10) }];
  return { hooks };
}

export type HookClient = "claude-code" | "codex" | "cursor";
export const hookClients: readonly HookClient[] = ["claude-code", "codex", "cursor"];

export interface HookOptions {
  /** Which harness reads the output: Claude Code takes plain text, Codex takes additionalContext JSON, Cursor takes followup_message on stop. On stop, Claude Code continues through hookSpecificOutput.additionalContext, Codex through decision block; both warn through systemMessage otherwise. */
  readonly client?: HookClient | undefined;
  readonly workspace?: string | undefined;
  readonly cacheDir?: string | undefined;
  readonly command?: readonly string[] | undefined;
  /** Include the opt-in PostToolUse grep nudge in the install preview. */
  readonly nudge?: boolean | undefined;
  /** Session: restate the whole tool contract instead of one pointer to the tools. */
  readonly fullContract?: boolean | undefined;
  /** How long the session hook waits for a background build of a cold repository before answering without starting points (default 3,000 ms). */
  readonly sessionWaitMs?: number | undefined;
  /** How to start a background build; defaults to this executable. Tests pass a no-op. */
  readonly backgroundBuild?: ((workspace: string, cacheDir: string | undefined) => void) | undefined;
}

function defaultBackgroundBuild(workspace: string, cacheDir: string | undefined): void {
  const script = process.argv[1];
  if (script === undefined) return;
  const child = spawn(process.execPath, [script, "build", workspace, ...(cacheDir === undefined ? [] : ["--cache-dir", cacheDir])], { detached: true, stdio: "ignore" });
  child.unref();
}

// The same context, shaped for the harness that asked: plain text for Claude Code; for Codex the hook
// output object it validates, `hookSpecificOutput` with the event name and `additionalContext`.
function emitContext(io: CliIo, client: HookClient, event: "prompt" | "session", text: string): void {
  if (client === "codex") { io.stdout(JSON.stringify({ hookSpecificOutput: { hookEventName: event === "prompt" ? "UserPromptSubmit" : "SessionStart", additionalContext: text } })); return; }
  io.stdout(text);
}

// Stop output per harness. Continuing the turn: Claude Code honors hookSpecificOutput.additionalContext on
// Stop as non-error feedback that continues the conversation; Codex honors only decision "block" with a reason;
// Cursor auto-submits followup_message as the next user message. Not continuing: systemMessage is a user-facing
// warning for Claude Code and Codex; Cursor has no such field, so it gets nothing.
function emitStop(io: CliIo, client: HookClient, text: string, continues: boolean): void {
  if (client === "cursor") { if (continues) io.stdout(JSON.stringify({ followup_message: text })); return; }
  if (!continues) { io.stdout(JSON.stringify({ systemMessage: text })); return; }
  if (client === "codex") { io.stdout(JSON.stringify({ decision: "block", reason: text })); return; }
  io.stdout(JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: text } }));
}

function settleContinueThreshold(): number {
  const raw = process.env.OSNOVA_HOOK_SETTLE_BLOCK_AT;
  if (raw === undefined || raw.trim().length === 0) return defaultSettleContinueThreshold;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultSettleContinueThreshold;
}

export async function runHook(event: HookEvent, raw: string, io: CliIo, options: HookOptions): Promise<void> {
  const client = options.client ?? "claude-code";
  if (event === "install-preview") {
    io.stdout([
      `osnova hook preview for ${client}: add these hooks to ${hookFileDescription(client)}, or run osnova setup --apply --hooks --client ${client}.`,
      `The stop hook continues the turn at most once per diff per session${client === "cursor" ? "" : ", and only when more than OSNOVA_HOOK_SETTLE_BLOCK_AT (default 1) indexed dependents lie outside the change; otherwise it warns through systemMessage"}; its state lives under the osnova cache directory.`,
      hookSettingsSnippet(options.command ?? ["osnova"], client, options.nudge === true),
    ].join("\n"));
    return;
  }
  const input = parseHookInput(raw);
  const workspace = options.workspace ?? workspaceRootFor(input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const fail = (error: unknown): void => io.stderr(`osnova hook: ${error instanceof Error ? error.message : String(error)}`);
  if (event === "session") {
    try {
      let cached = await loadIndex(workspace, { cacheDir: options.cacheDir });
      if (cached === undefined) {
        (options.backgroundBuild ?? defaultBackgroundBuild)(workspace, options.cacheDir);
        // A small repository builds in well under the wait, so its first prompt already has starting points.
        const deadline = Date.now() + (options.sessionWaitMs ?? 3_000);
        while (cached === undefined && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          cached = await loadIndex(workspace, { cacheDir: options.cacheDir });
        }
        if (cached === undefined) {
          emitContext(io, client, "session", boundText(formatSessionContext("Index: building in the background; starting points appear from the next prompt.", options.fullContract === true), hookSessionCodeUnits));
          return;
        }
      }
      const index = await refreshWorkspace(workspace, { cacheDir: options.cacheDir });
      emitContext(io, client, "session", boundText(formatSessionContext(`Indexed: ${index.files.size} files, ${index.symbols.size} symbols.`, options.fullContract === true), hookSessionCodeUnits));
    } catch (error) { fail(error); }
    return;
  }
  if (event === "stop") {
    if (input.stopHookActive === true || process.env.OSNOVA_HOOK_SETTLE === "off") return;
    try {
      const cached = await loadIndex(workspace, { cacheDir: options.cacheDir });
      if (cached === undefined) return;
      const { stdout: diff } = await execFileAsync("git", ["-C", workspace, "diff", "HEAD", "--no-color", "--no-ext-diff"], { encoding: "utf8", maxBuffer: maximumDiffBytes });
      if (diff.trim().length === 0) return;
      const index = await refreshWorkspace(workspace, { cacheDir: options.cacheDir });
      const result = impact(index, index, { diff, maxDepth: 1 });
      const dependents = result.dependents.filter((dependent) => dependent.snapshot === "current");
      if (dependents.length === 0) return;
      const digest = createHash("sha256").update(diff).digest("hex").slice(0, 16);
      const stateFile = input.sessionId === undefined ? undefined : hookStateFile(options.cacheDir, input.sessionId);
      const state = stateFile === undefined ? emptyHookState : await readHookState(stateFile);
      const continues = !state.settled.includes(digest) && (client === "cursor" || dependents.length > settleContinueThreshold());
      if (continues && stateFile !== undefined) await writeHookState(stateFile, { ...state, settled: [...state.settled, digest] });
      emitStop(io, client, boundText(formatStopReason(result), hookStopCodeUnits), continues);
    } catch (error) { fail(error); }
    return;
  }
  if (event === "search") {
    if (client !== "claude-code") return;
    try {
      const answer = await searchAnswer(input, workspace, options.cacheDir);
      if (answer === null) return;
      // A Bash search is rewritten to print the answer, so the tool succeeds with it and there is nothing to
      // retry; the Grep tool cannot print text, so it is denied with the answer as the reason.
      const bash = input.toolName === "Bash" || input.toolName === "bash";
      io.stdout(JSON.stringify({ hookSpecificOutput: bash
        ? { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "osnova answered this search from the call graph", updatedInput: { ...input.toolInput, command: printCommand(answer) } }
        : { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: answer } }));
    } catch (error) { fail(error); }
    return;
  }
  if (event === "tool") {
    const name = grepName(input.toolName, input.toolInput);
    if (name === null || input.sessionId === undefined) return;
    try {
      const stateFile = hookStateFile(options.cacheDir, input.sessionId);
      const state = await readHookState(stateFile);
      if (state.nudges.includes(name)) return;
      const cached = await loadIndex(workspace, { cacheDir: options.cacheDir });
      if (cached === undefined) return;
      const index = await refreshWorkspace(workspace, { cacheDir: options.cacheDir });
      const text = formatGrepNudge(index, name);
      if (text === null) return;
      await writeHookState(stateFile, { ...state, nudges: [...state.nudges, name] });
      io.stdout(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }));
    } catch (error) { fail(error); }
    return;
  }
  const prompt = (input.prompt ?? "").trim();
  if (prompt.length < minimumPromptLength || prompt.startsWith("/")) return;
  try {
    const cached = await loadIndex(workspace, { cacheDir: options.cacheDir });
    if (cached === undefined) return;
    const terms = promptCodeNames(prompt);
    if (terms.length === 0) return;
    const index = await refreshWorkspace(workspace, { cacheDir: options.cacheDir });
    const seeds = symbolsNamed(index, terms, 8);
    if (seeds.length === 0) return;
    const header = "[osnova] starting points for this prompt (indexed graph, exact file:line; osnova_footing for the full context, osnova_warp <symbol> for callers):";
    const available = hookPromptCodeUnits - header.length - 1;
    const seedNames = new Set(seeds.map((symbol) => symbol.qualifiedName));
    const result = taskContext(index, { task: "understand", question: prompt, symbols: [...seedNames], maxDepth: 1, maxCodeUnits: available, excerptLines: 1, measure: (partial) => formatStartingPoints(partial, seedNames).length });
    const text = formatStartingPoints(result, seedNames);
    if (!text.startsWith("- ")) return;
    emitContext(io, client, "prompt", `${header}\n${boundText(text, available)}`);
  } catch (error) { fail(error); }
}

// One line per named definition, then the count of what the graph holds beyond them. Relationships are not
// printed: the callees are visible in the body the agent reads next, and callers belong to osnova_warp.
const STARTING_POINT_KINDS = new Set(["function", "method", "class", "interface", "struct", "enum", "trait", "module", "type"]);
export function formatStartingPoints(result: TaskContextResult, seeds: ReadonlySet<string>): string {
  const lines: string[] = [];
  let related = 0;
  for (const definition of result.definitions) {
    const symbol = definition.symbol;
    if (!seeds.has(symbol.qualifiedName)) { related++; continue; }
    if (!STARTING_POINT_KINDS.has(symbol.kind)) continue;
    lines.push(`- ${symbol.kind} ${symbol.qualifiedName} ${symbol.file}:${symbol.span.startLine}`);
  }
  const definitions = result.omitted.definitions + related;
  const relationships = result.omitted.relationships + result.relationships.length;
  if (definitions > 0 || relationships > 0) lines.push(`  omitted: ${definitions} definitions, ${relationships} relationships`);
  return lines.join("\n");
}

// The stop reason the agent reads once: the changed symbols and who depends on them, grouped by file so a
// large diff still names every file inside the budget, with the omitted remainder counted, never clipped mid-line.
export function formatStopReason(result: ImpactResult, maxCodeUnits = hookStopCodeUnits): string {
  const changed = result.changes.map((change) => change.after?.symbol.qualifiedName ?? change.before?.symbol.qualifiedName ?? "<unknown>");
  const dependents = result.dependents.filter((dependent) => dependent.snapshot === "current");
  const byFile = new Map<string, string[]>();
  for (const dependent of dependents) {
    const list = byFile.get(dependent.file) ?? [];
    if (dependent.symbol !== null) list.push(`${dependent.symbol.qualifiedName.slice(dependent.symbol.qualifiedName.indexOf("#") + 1)}:${dependent.symbol.span.startLine}`);
    byFile.set(dependent.file, list);
  }
  const files = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  const head = `[osnova settle] The uncommitted diff touches ${changed.length} indexed symbols; ${dependents.length} indexed dependents in ${files.length} files were not part of the change. Check each dependent still holds, then finish (this notice fires once).`;
  const tail = result.uncertainty.unresolvedEdges > 0 ? `${result.uncertainty.unresolvedEdges} unresolved edges are not listed; a missing dependent is not proof of absence.` : "";
  const lines: string[] = [];
  let used = head.length + (tail.length > 0 ? tail.length + 1 : 0) + 1;
  let listed = 0;
  for (const [file, symbols] of files) {
    const shown = symbols.slice(0, 6);
    const line = `- ${file}${symbols.length === 0 ? " (file level)" : `: ${shown.join(", ")}${symbols.length > shown.length ? ` and ${symbols.length - shown.length} more` : ""}`}`;
    const omittedLine = `- ${files.length - listed} more files with ${files.slice(listed).reduce((sum, [, list]) => sum + Math.max(1, list.length), 0)} dependents omitted; osnova_settle lists them all.`;
    if (used + line.length + 1 + (listed + 1 < files.length ? omittedLine.length + 1 : 0) > maxCodeUnits) { lines.push(omittedLine); break; }
    lines.push(line);
    used += line.length + 1;
    listed += 1;
  }
  return [head, ...lines, ...(tail.length > 0 ? [tail] : [])].join("\n");
}

// The names a prompt spells as code: a backticked token, or a bare identifier with an inner capital,
// an underscore or a digit. Plain words never seed the prompt hook, so "load" or "within" in prose
// cannot pull in an unrelated definition of that name.
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function promptCodeNames(prompt: string): string[] {
  const names = new Set<string>();
  const consider = (token: string, quoted: boolean): void => {
    const last = token.split(/[.#:/\\]/).filter((part) => part.length > 0).at(-1) ?? "";
    const bare = last.replace(/\(.*$/, "");
    if (bare.length < 3 || !identifierPattern.test(bare)) return;
    if (quoted || /[A-Z]|_|\d/.test(bare.slice(1))) names.add(bare);
  };
  for (const match of prompt.matchAll(/`([^`\n]+)`/g)) consider(match[1]!.trim(), true);
  for (const match of prompt.replace(/`[^`\n]+`/g, " ").matchAll(/[A-Za-z_][A-Za-z0-9_.#:/]*/g)) consider(match[0], false);
  return [...names].sort();
}

function symbolsNamed(index: OsnovaIndex, names: readonly string[], limit: number): OsnovaSymbol[] {
  const wanted = new Set(names);
  const found: OsnovaSymbol[] = [];
  for (const symbol of index.symbols.values()) {
    if (!wanted.has(symbol.name) || !STARTING_POINT_KINDS.has(symbol.kind)) continue;
    found.push(symbol);
  }
  found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.span.startLine - b.span.startLine));
  const perName = new Map<string, number>();
  const kept: OsnovaSymbol[] = [];
  for (const symbol of found) {
    const seen = perName.get(symbol.name) ?? 0;
    if (seen >= 4 || kept.length >= limit) continue;
    perName.set(symbol.name, seen + 1);
    kept.push(symbol);
  }
  return kept;
}

// The identifier a Grep call or a Bash grep/rg command searched for, when the pattern is one plain identifier.
// Flags that take a separate value are skipped with their value, so `rg -t ts name` finds `name`, not `ts`.
const valueFlags = /^-(?:[fgtmABCdE]|-(?:file|glob|iglob|type|type-not|max-count|max-depth|context|after-context|before-context|include|exclude|exclude-dir|color|colour|sort|sortr|threads|regexp))$/;
export function grepName(toolName: string | undefined, toolInput: Readonly<Record<string, unknown>> | undefined): string | null {
  if (toolInput === undefined) return null;
  let pattern: string | undefined;
  if (toolName === "Grep" && typeof toolInput.pattern === "string") pattern = toolInput.pattern;
  else if (toolName === "Bash" && typeof toolInput.command === "string") {
    const match = /(?:^|[|;&]\s*)(?:rg|grep|git grep)\b(.*)$/m.exec(toolInput.command);
    if (match === null) return null;
    const words = match[1]!.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i]!;
      if (word === "--") { pattern = words[i + 1]; break; }
      if (word.startsWith("-")) {
        if (/^-e$|^--regexp$/.test(word)) { pattern = words[i + 1]; break; }
        if (valueFlags.test(word)) i += 1;
        continue;
      }
      pattern = word; break;
    }
    if (pattern === undefined) return null;
    pattern = pattern.replace(/^["']|["']$/g, "");
  }
  if (pattern === undefined) return null;
  // `\.invoke(` and `.total(` are how a method is grepped; the name is what the index knows.
  const bare = pattern.replace(/^\\b|\\b$/g, "").replace(/^\^|\$$/g, "").replace(/^(?:\\\.|\.)/, "").replace(/(?:\\\(|\()$/, "");
  return bare.length >= 3 && identifierPattern.test(bare) ? bare : null;
}

// One line, once per name per session: how many resolved call sites the index holds for what was just grepped.
export function formatGrepNudge(index: OsnovaIndex, name: string): string | null {
  const symbols = [...index.symbols.values()].filter((symbol) => symbol.name === name && STARTING_POINT_KINDS.has(symbol.kind));
  if (symbols.length === 0) return null;
  let resolved = 0, unresolved = 0;
  const files = new Set<string>();
  for (const symbol of symbols) {
    for (const edge of index.incoming(symbol.qualifiedName)) {
      if (edge.kind !== "calls") continue;
      if (edge.evidence?.source === "syntax" && edge.evidence.resolution.status === "resolved" && edge.toSymbol === symbol.qualifiedName) { resolved += 1; files.add(edge.fromFile); } else unresolved += 1;
    }
  }
  if (resolved === 0) return null;
  const target = symbols.length === 1 ? symbols[0]!.qualifiedName : `${name} (${symbols.length} definitions)`;
  return `[osnova] ${target} is indexed: ${resolved} resolved call sites in ${files.size} files; osnova_warp ${symbols.length === 1 ? symbols[0]!.qualifiedName : name} lists them with exact file:line${unresolved > 0 ? ` and ${unresolved} unresolved same-name calls` : ""}.`;
}

// Per-session hook state, one file per session under the cache directory: the grep names already nudged
// and the diff digests the stop hook already continued on. A missing or unreadable file is an empty state.
interface HookState {
  readonly nudges: readonly string[];
  readonly settled: readonly string[];
  /** Digests of searches the search hook already answered; the same search again runs. */
  readonly denied: readonly string[];
}
const emptyHookState: HookState = { nudges: [], settled: [], denied: [] };

function hookStateFile(cacheDir: string | undefined, sessionId: string): string {
  return path.join(resolveCacheDir(cacheDir), "hook-state", `${sessionId.replace(/[^\w.-]/g, "_")}.json`);
}
async function readHookState(file: string): Promise<HookState> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<Record<keyof HookState, unknown>>;
    const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
    return { nudges: strings(parsed.nudges), settled: strings(parsed.settled), denied: strings(parsed.denied) };
  } catch { return emptyHookState; }
}
// Written to a unique name and renamed into place, so a reader never sees half a file.
async function writeHookState(file: string, state: HookState): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const staged = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(staged, JSON.stringify({ nudges: [...new Set(state.nudges)], settled: [...new Set(state.settled)], denied: [...new Set(state.denied)] }));
  await fs.rename(staged, file);
}

// The search hook's decision: the graph answer to deny the search with, or null to let it run.
// The hook exists to cut what the agent reads, so it denies only when its answer is clearly smaller
// than the lines the search would print, estimated from the indexed text, and it lists every text
// match the graph does not cover by location, so nothing the search would find goes unmentioned.
// Null on any doubt: not a single line-printing repository search, not a pure name hunt, a path that
// is dynamic, missing or outside the workspace, a file in scope too large to index, no index, a name
// the index does not define or defines too often, or the same search already answered this session.
const searchOptOut = /(?:^|[\s;&|])OSNOVA_GREP=1(?:\s|$)/;
const answerDelimiter = "OSNOVA_GRAPH_ANSWER";
// A shell command that prints the answer verbatim: a quoted heredoc expands nothing.
export function printCommand(answer: string): string {
  const safe = answer.split("\n").map((line) => (line === answerDelimiter ? ` ${line}` : line)).join("\n");
  return `cat <<'${answerDelimiter}'\n${safe}\n${answerDelimiter}`;
}

export async function searchAnswer(input: HookInput, workspace: string, cacheDir: string | undefined): Promise<string | null> {
  if (typeof input.toolInput?.command === "string" && searchOptOut.test(input.toolInput.command)) return null;
  const call = parseSearchCall(input.toolName, input.toolInput);
  if (call === null || call.shape !== "lines") return null;
  const names = symbolHuntNames(call.patterns);
  if (names === null) return null;
  const cwd = path.resolve(input.cwd ?? workspace, call.base);
  const scopes: string[] = [];
  for (const written of call.paths.length === 0 ? ["."] : call.paths) {
    const absolute = path.resolve(cwd, written);
    const relative = path.relative(workspace, absolute).split(path.sep).join("/");
    if (relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(absolute)) return null;
    scopes.push(relative);
  }
  const digest = createHash("sha256").update(JSON.stringify([input.toolName, input.toolInput])).digest("hex").slice(0, 16);
  const stateFile = input.sessionId === undefined ? undefined : hookStateFile(cacheDir, input.sessionId);
  const state = stateFile === undefined ? emptyHookState : await readHookState(stateFile);
  if (state.denied.includes(digest)) return null;
  if ((await loadIndex(workspace, { cacheDir })) === undefined) return null;
  const index = await refreshWorkspace(workspace, { cacheDir });
  // The lines the search itself would print, found with its own pattern and flags in the indexed text.
  const regex = searchRegExp(call);
  if (regex === null) return null;
  const textMatches = new Map<string, string>();
  for (const scope of scopes) {
    const found = findTextDetailed(index, regex.source, { in: scope, ignoreCase: regex.flags.includes("i"), matchesPerGroup: Number.MAX_SAFE_INTEGER });
    if (found.unsearchedFiles.length > 0 || found.truncated) return null;
    for (const group of found.groups) for (const match of group.matches) textMatches.set(`${group.file}:${match.line}`, match.text);
  }
  if (textMatches.size === 0) return null;
  const answer = formatSearchAnswer(index, names, scopes, textMatches);
  if (answer === null) return null;
  // What the search would print: file:line:text, without the file when it searches one file, cut at a head.
  const singleFile = call.paths.length === 1 && statSync(path.resolve(cwd, call.paths[0]!)).isFile();
  const printed = [...textMatches.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, call.maxLines ?? Number.MAX_SAFE_INTEGER);
  const searchChars = printed.reduce((sum, [site, text]) => sum + (singleFile ? site.length - site.lastIndexOf(":") - 1 : site.length) + text.length + 2, 0);
  if (answer.text.length > searchChars * searchAnswerMaximumShare || answer.otherMatches > answer.codeSites) return null;
  if (stateFile !== undefined) await writeHookState(stateFile, { ...state, denied: [...state.denied, digest] });
  return answer.text;
}

/** The answer must be at most this share of the search output it replaces, or the search runs. */
const searchAnswerMaximumShare = 0.8;
const SEARCH_DEFINITION_KINDS = new Set(["function", "method", "class", "interface", "struct", "enum", "trait", "module", "type", "constant"]);
const inAnyScope = (file: string, scopes: readonly string[]): boolean => scopes.some((scope) => scope === "" || file === scope || file.startsWith(`${scope}/`));
const SITE_LABELS = ["called from", "imported by", "referenced by", "routed from", "unresolved same-name calls"] as const;
type SiteGroup = { readonly label: string; readonly files: readonly (readonly [string, readonly string[]])[] };

// Each file's sites as `line` or `line name`, where name is the enclosing definition that makes the call.
function siteGroups(byLabel: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<number, string>>>, labels: readonly string[]): SiteGroup[] {
  return labels.flatMap((label) => {
    const byFile = byLabel.get(label);
    if (byFile === undefined) return [];
    const files = [...byFile.entries()].map(([file, lines]) => [file, [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([line, name]) => (name === "" ? `${line}` : `${line} ${name}`))] as const)
      .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
    return [{ label, files }];
  });
}

// Definitions, then resolved sites grouped by kind and file with every line, then unresolved same-name
// calls, then the text matches (comments, strings, other files) the graph does not cover; each group
// lists files until the budget and counts the rest exactly. Null when a name is not defined, is defined
// more than searchMaximumDefinitions times, or has nothing inside the searched paths.
export interface SearchAnswer {
  readonly text: string;
  /** Distinct code lines the answer names: definitions and graph sites inside the searched paths. */
  readonly codeSites: number;
  /** Text matches inside the searched paths that no code site covers: comments, strings, other files. */
  readonly otherMatches: number;
}

export function formatSearchAnswer(index: OsnovaIndex, names: readonly string[], scopes: readonly string[], textMatches: ReadonlyMap<string, string> = new Map(), maxCodeUnits = hookSearchCodeUnits): SearchAnswer | null {
  const head = "[osnova] Answered from the call graph instead of running this search: every code site with exact file:line and the definition at each site, then any other text matches by location.";
  const covered = new Set<string>();
  const blocks: { title: string; groups: SiteGroup[] }[] = [];
  for (const name of names) {
    const definitions = [...index.symbols.values()].filter((symbol) => symbol.name === name && SEARCH_DEFINITION_KINDS.has(symbol.kind));
    if (definitions.length === 0 || definitions.length > searchMaximumDefinitions) return null;
    const byLabel = new Map<string, Map<string, Map<number, string>>>();
    const add = (label: string, file: string, line: number, from = ""): void => {
      if (!inAnyScope(file, scopes)) return;
      covered.add(`${file}:${line}`);
      const byFile = byLabel.get(label) ?? new Map<string, Map<number, string>>(); byLabel.set(label, byFile);
      const lines = byFile.get(file) ?? new Map<number, string>(); byFile.set(file, lines);
      if (!lines.has(line)) lines.set(line, from.includes("#") ? from.slice(from.indexOf("#") + 1) : "");
    };
    for (const symbol of definitions) {
      for (const edge of index.incoming(symbol.qualifiedName)) {
        const label = edge.kind === "calls" ? "called from" : edge.kind === "imports" ? "imported by" : edge.kind === "routes" ? "routed from" : "referenced by";
        add(label, edge.fromFile, edge.line, label === "imported by" ? "" : edge.fromSymbol);
      }
    }
    // An import edge points at a file; it imports this name when its line spells the name.
    const definingFiles = new Set(definitions.map((symbol) => symbol.file));
    const word = new RegExp(`\\b${name}\\b`);
    const lineCache = new Map<string, string[]>();
    const lineOf = (file: string, line: number): string => {
      let lines = lineCache.get(file);
      if (lines === undefined) { lines = (index.files.get(file)?.text ?? "").split("\n"); lineCache.set(file, lines); }
      return lines[line - 1] ?? "";
    };
    for (const edge of index.edges) {
      if (edge.kind === "calls" && edge.toSymbol === undefined && edge.toName === name) add("unresolved same-name calls", edge.fromFile, edge.line, edge.fromSymbol);
      else if (edge.kind === "imports" && edge.toFile !== undefined && definingFiles.has(edge.toFile) && word.test(lineOf(edge.fromFile, edge.line))) add("imported by", edge.fromFile, edge.line);
    }
    const shown = definitions.filter((symbol) => inAnyScope(symbol.file, scopes));
    for (const symbol of shown) covered.add(`${symbol.file}:${symbol.span.startLine}`);
    if (shown.length === 0 && byLabel.size === 0) continue;
    const title = `${name}: ${shown.length === 0 ? `defined outside the searched paths (${definitions.map((symbol) => symbol.qualifiedName).join(", ")})` : shown.map((symbol) => `${symbol.kind} ${symbol.file}:${symbol.span.startLine}`).join("; ")}`;
    blocks.push({ title, groups: siteGroups(byLabel, SITE_LABELS) });
  }
  if (blocks.length === 0) return null;
  const other = new Map<string, Map<number, string>>();
  for (const site of textMatches.keys()) {
    if (covered.has(site)) continue;
    const colon = site.lastIndexOf(":");
    const file = site.slice(0, colon);
    const lines = other.get(file) ?? new Map<number, string>(); other.set(file, lines); lines.set(Number(site.slice(colon + 1)), "");
  }
  if (other.size > 0) blocks.push({ title: "other text matches (comments, strings, non-code files):", groups: siteGroups(new Map([["at", other]]), ["at"]) });
  const otherMatches = [...other.values()].reduce((sum, lines) => sum + lines.size, 0);
  // Every site is listed: an answer cut short sends the agent back to grep, which costs more than no answer.
  const text = [head, ...blocks.flatMap((block) => [block.title, ...block.groups.map(({ label, files }) => {
    const sites = files.reduce((sum, [, lines]) => sum + lines.length, 0);
    const listed = files.map(([file, lines]) => `${file}:${lines.join(",")}`).join(" · ");
    return `  ${label} ${sites} site${sites === 1 ? "" : "s"} in ${files.length} file${files.length === 1 ? "" : "s"}: ${listed}`;
  })])].join("\n");
  if (text.length > maxCodeUnits) return null;
  return { text, codeSites: covered.size, otherMatches };
}

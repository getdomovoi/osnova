import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OsnovaIndex } from "../types.js";

// The search gate. A text instruction can be skipped; a PreToolUse deny cannot. This module is the
// decision, with no input and output shaping in it, so every case below is a plain unit test.
//
// The gate denies plain search inside an indexed workspace until osnova has run in the current turn.
// After osnova has been tried, search is allowed as a fallback: osnova does not index every file.

const searchCommands = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "fd", "find"]);
// Words that stand in front of the command being run and are not the command itself.
const wrapperWords = /^(?:\w+=\S*|sudo|command|exec|time|env|nice|nohup|xargs)$/;

/**
 * An osnova tool under every install form seen so far: `mcp__osnova__osnova_ground` for the plain MCP
 * install, `mcp__plugin_<scope>_osnova__…` for the plugin install, and the bare `osnova_ground` that
 * Cursor reports in `afterMCPExecution` with the server name in a separate field.
 */
export function isOsnovaToolName(name: string | undefined): boolean {
  return name !== undefined && /(?:^|_)osnova/i.test(name);
}

export function expandPath(value: string, cwd: string): string {
  const home = value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value;
  return path.resolve(cwd, home);
}

export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export interface ShellScan {
  /** One entry per search command found; each entry holds the paths that command searches, empty when it searches the working directory. */
  readonly searches: readonly (readonly string[])[];
  /** The command also ran the osnova CLI, which counts as having tried osnova this turn. */
  readonly usedOsnova: boolean;
}

interface Stage {
  readonly words: readonly string[];
  /** The stage reads another command's output, so it filters rather than searches. */
  readonly afterPipe: boolean;
}

// Splitting on `|` with a regular expression cuts `grep -nE "FAIL|error" notes.txt` in half and loses the
// path, which then reads as a search of the whole workspace. The separators only count outside quotes.
export function shellStages(command: string): Stage[] {
  const stages: Stage[] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let afterPipe = false;
  let quote: "'" | "\"" | null = null;
  const endWord = (): void => { if (started) { words.push(word); word = ""; started = false; } };
  const endStage = (nextAfterPipe: boolean): void => { endWord(); if (words.length > 0) stages.push({ words, afterPipe }); words = []; afterPipe = nextAfterPipe; };
  for (let i = 0; i < command.length; i += 1) {
    const character = command[i]!;
    if (quote !== null) {
      if (character === quote) quote = null; else { word += character; started = true; }
      continue;
    }
    if (character === "'" || character === "\"") { quote = character; started = true; continue; }
    if (character === "\\" && i + 1 < command.length) { word += command[i + 1]!; started = true; i += 1; continue; }
    if (character === "|") { const double = command[i + 1] === "|"; endStage(!double); if (double) i += 1; continue; }
    if (character === "&") { if (command[i + 1] === "&") i += 1; endStage(false); continue; }
    if (character === ";" || character === "\n") { endStage(false); continue; }
    if (/\s/.test(character)) { endWord(); continue; }
    word += character; started = true;
  }
  endStage(false);
  return stages;
}

// Only the command that opens a pipeline stage is a search. `git status | grep x` filters output that
// is already in hand, so it is never gated.
export function scanShellCommand(command: string, cwd: string): ShellScan {
  const searches: string[][] = [];
  let usedOsnova = false;
  for (const stage of shellStages(command)) {
    const words = [...stage.words];
    while (words.length > 0 && wrapperWords.test(words[0]!)) words.shift();
    if (words.length === 0) continue;
    const head = path.basename(words[0]!);
    if (head === "osnova") usedOsnova = true;
    if (stage.afterPipe) continue;
    if (!searchCommands.has(head) && !(head === "git" && words[1] === "grep")) continue;
    searches.push(searchPaths(words.slice(1), cwd));
  }
  return { searches, usedOsnova };
}

// A path argument is one that is written as a path (`.`, `/x`, `~/x`) or one that names something that
// actually exists next to the caller. A pattern that happens to name a file only adds a target the
// gate would otherwise have taken from the working directory, so it can never turn a deny into an allow.
function searchPaths(args: readonly string[], cwd: string): string[] {
  const found: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    if (/^[~/.]/.test(arg)) { found.push(expandPath(arg, cwd)); continue; }
    if (!/[*?[\]]/.test(arg) && existsSync(path.resolve(cwd, arg))) found.push(path.resolve(cwd, arg));
  }
  return found;
}

export interface GateRequest {
  readonly toolName: string | undefined;
  readonly toolInput: Readonly<Record<string, unknown>> | undefined;
  readonly cwd: string;
}

export interface GateSubject {
  /** Absolute paths the call searches. */
  readonly targets: readonly string[];
  readonly usedOsnova: boolean;
  /** What to name in the deny reason. */
  readonly label: string;
}

// Every client names its tools differently: Claude Code has Grep, Glob and Bash; Codex has grep, glob,
// search and shell; Cursor reports Shell and Grep; Pi has bash, grep and find. Rather than keep four
// name tables that go stale, the gate reads the call's shape: a `command` field is a shell command, and
// a tool named after a search tool searches the path it was given.
const searchToolNames = new Set(["grep", "glob", "search", "find", "rg", "ripgrep", "codebase_search", "file_search"]);
const commandFields = ["command", "cmd"] as const;
const pathFields = ["path", "paths", "search_paths", "directory", "dir", "workdir", "cwd"] as const;

function shellCommandOf(toolInput: Readonly<Record<string, unknown>> | undefined): string | null {
  for (const field of commandFields) {
    const value = toolInput?.[field];
    if (typeof value === "string" && value.length > 0) return value;
    // Codex and some MCP shells pass argv as a list; joining it is enough to read the head and its paths.
    if (Array.isArray(value) && value.every((part) => typeof part === "string") && value.length > 0) return value.join(" ");
  }
  return null;
}

function givenPaths(toolInput: Readonly<Record<string, unknown>> | undefined): string[] {
  const found: string[] = [];
  for (const field of pathFields) {
    const value = toolInput?.[field];
    if (typeof value === "string" && value.length > 0) found.push(value);
    else if (Array.isArray(value)) for (const part of value) if (typeof part === "string" && part.length > 0) found.push(part);
  }
  return found;
}

/** What this tool call searches, or null when the gate has nothing to say about it. */
export function gateSubject(request: GateRequest): GateSubject | null {
  const { toolName, toolInput, cwd } = request;
  const command = shellCommandOf(toolInput);
  if (command !== null) {
    const { searches, usedOsnova } = scanShellCommand(command, cwd);
    if (searches.length === 0) return { targets: [], usedOsnova, label: "grep/rg/find" };
    return { targets: searches.flatMap((paths) => (paths.length > 0 ? [...paths] : [cwd])), usedOsnova, label: "grep/rg/find" };
  }
  if (toolName === undefined || !searchToolNames.has(toolName.toLowerCase())) return null;
  const given = givenPaths(toolInput);
  const targets = given.length > 0 ? given.map((value) => expandPath(value, cwd)) : [cwd];
  return { targets, usedOsnova: false, label: toolName };
}

export type GateClient = "claude-code" | "codex" | "cursor" | "pi";
export const gateClientIds: readonly GateClient[] = ["claude-code", "codex", "cursor", "pi"];

// One decision, three wire shapes. Claude Code and Codex read the same nested object (Codex 0.155.1
// accepts only `deny` there: its binary carries the errors "PreToolUse hook returned unsupported
// permissionDecision:allow" and ":ask"). Cursor reads a flat, snake_case object with a message for the
// human and a message for the model. Pi's extension host takes a typed result from the handler.
export function gateDecisionPayload(client: GateClient, reason: string): unknown {
  if (client === "cursor") return { permission: "deny", user_message: "osnova: search the index first", agent_message: reason };
  if (client === "pi") return { block: true, reason };
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

/** How many indexed files lie at or under an absolute path. Zero means osnova cannot answer a search there. */
export function indexedFilesUnder(index: OsnovaIndex, workspace: string, target: string): number {
  const relative = path.relative(workspace, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return 0;
  if (relative === "") return index.files.size;
  const posix = relative.split(path.sep).join("/");
  let count = 0;
  for (const file of index.files.keys()) if (file === posix || file.startsWith(`${posix}/`)) count += 1;
  return count;
}

export function denyReason(label: string, indexed: number, workspace: string): string {
  return [
    `osnova gate: ${workspace} is indexed by osnova (${indexed} indexed files under the path you searched), and no osnova tool has run yet in this turn, so ${label} was blocked.`,
    "Search the index first: osnova_footing (task context for a question), osnova_ground (find definitions and text), osnova_thread (exhaustive regex grouped by symbol), osnova_outline (one file's signatures), osnova_warp (callers or callees with exact file:line).",
    "After one osnova call in this turn, plain search is allowed again as a fallback for files osnova does not index.",
  ].join(" ");
}

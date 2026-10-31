import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OsnovaIndex } from "../types.js";

// The search gate's decision: what a tool call searches, and whether that reaches code osnova indexes. Turn
// state and output live in the hook; this module reads a call and an index and nothing else.

const searchCommands = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "fd", "find"]);
// Words that stand in front of the command being run and are not the command itself.
const wrapperWords = /^(?:\w+=\S*|sudo|command|exec|time|env|nice|nohup|xargs)$/;
const shellEscapable = /[\s'"\\|&;$`()<>*?[\]{}#!~]/;

/** A folder or file a call searches, with the file-name glob it is limited to, if any. */
export interface GateTarget { readonly path: string; readonly filter?: string | undefined }

/**
 * An osnova tool under every install form: `mcp__osnova__osnova_ground` for the plain MCP install,
 * `mcp__plugin_<scope>_osnova__…` for the plugin install, `osnova_osnova_ground` in OpenCode and Kilo, and the
 * bare `osnova_ground` that Cursor reports with the server name in a separate field.
 */
export function isOsnovaToolName(name: string | undefined): boolean {
  return name !== undefined && /(?:^|_)osnova/i.test(name);
}

function expandPath(value: string, cwd: string): string {
  return path.resolve(cwd, value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value);
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
    // A backslash escapes only a character the shell would otherwise act on, so `C:\Users\me\notes.txt` stays one path.
    if (character === "\\" && i + 1 < command.length && shellEscapable.test(command[i + 1]!)) { word += command[i + 1]!; started = true; i += 1; continue; }
    if (character === "|") { const double = command[i + 1] === "|"; endStage(!double); if (double) i += 1; continue; }
    if (character === "&") { if (command[i + 1] === "&") i += 1; endStage(false); continue; }
    if (character === ";" || character === "\n") { endStage(false); continue; }
    if (/\s/.test(character)) { endWord(); continue; }
    word += character; started = true;
  }
  endStage(false);
  return stages;
}

// Only the command that opens a pipeline stage is a search: `git status | grep x` filters output already in hand.
// `cd` moves the folder later stages search, also inside a `( … )` subshell. A variable the command sets with
// `NAME=value` is expanded; a path that still holds a `$` cannot be known, so it targets nothing, and a search or a
// `cd` into it lets the call through as any unreadable call does. Any stage that runs the osnova CLI counts as using
// osnova.
const assignment = /^([A-Za-z_]\w*)=(.*)$/s;
function scanShellCommand(command: string, cwd: string): "osnova" | GateTarget[] | undefined {
  const targets: GateTarget[] = [];
  const variables = new Map<string, string>();
  let here: string | undefined = cwd;
  let searched = false;
  for (const stage of shellStages(command)) {
    const words = stage.words.map((word, index, all) => {
      const opened = index === 0 ? word.replace(/^[({]+/, "") : word;
      return index === all.length - 1 ? opened.replace(/[)}]+$/, "") : opened;
    }).filter((word) => word.length > 0);
    const assigned = words.findIndex((word) => !assignment.test(word));
    if (assigned === -1) { for (const word of words) { const [, name, value] = assignment.exec(word)!; variables.set(name!, expandVariables(value!, variables) ?? ""); } continue; }
    words.splice(0, assigned);
    while (words.length > 0 && wrapperWords.test(words[0]!)) words.shift();
    if (words.length === 0) continue;
    const head = path.basename(words[0]!);
    if (head === "osnova") return "osnova";
    if (stage.afterPipe) continue;
    const expanded = words.map((word) => expandVariables(word, variables));
    if (head === "cd") { const to = words[1] === undefined ? "~" : expanded[1]; here = here === undefined || to === undefined ? undefined : expandPath(to, here); continue; }
    if (!searchCommands.has(head) && !(head === "git" && words[1] === "grep")) continue;
    searched = true;
    if (here === undefined) continue;
    const args = expanded.slice(head === "git" ? 2 : 1);
    const paths = searchPaths(args.filter((arg): arg is string => arg !== undefined), here);
    const unknown = args.some((arg) => arg === undefined);
    targets.push(...(paths.length > 0 ? paths : unknown ? [] : [here]).map((target) => ({ path: target })));
  }
  return searched ? targets : undefined;
}

// `$NAME` and `${NAME}` from the command's own assignments; undefined when a variable is not known here.
function expandVariables(word: string, variables: ReadonlyMap<string, string>): string | undefined {
  let unknown = false;
  const result = word.replace(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (_match, braced: string | undefined, bare: string | undefined) => {
    const value = variables.get((braced ?? bare)!);
    if (value === undefined) unknown = true;
    return value ?? "";
  });
  return unknown || result.includes("$") ? undefined : result;
}

// A path argument is one written as a path (`.`, `/x`, `~/x`) or one that names something that exists. A pattern
// that happens to name a file only adds a target the working directory would have covered, so it cannot turn a
// deny into an allow.
function searchPaths(args: readonly string[], cwd: string): string[] {
  const found: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    if (/^[~/.]/.test(arg)) { found.push(expandPath(arg, cwd)); continue; }
    if (!/[*?[\]]/.test(arg) && existsSync(path.resolve(cwd, arg))) found.push(path.resolve(cwd, arg));
  }
  return found;
}

// Every client names its tools differently: Claude Code has Grep, Glob and Bash; Codex has grep, glob, search and
// shell; Cursor reports Shell and Grep; OpenCode, Kilo and Pi have bash, grep, glob and find. Rather than keep name
// tables that go stale, the gate reads the call's shape: a `command` field is a shell command, and a tool named
// after a search tool searches the paths it was given.
const searchToolNames = new Set(["grep", "glob", "search", "find", "rg", "ripgrep", "codebase_search", "file_search"]);
// Tools whose `pattern` names files rather than text.
const fileGlobTools = new Set(["glob", "find"]);
const commandFields = ["command", "cmd"] as const;
const pathFields = ["path", "paths", "search_paths", "directory", "dir", "workdir", "cwd"] as const;

function shellCommandOf(toolInput: Readonly<Record<string, unknown>>): string | null {
  for (const field of commandFields) {
    const value = toolInput[field];
    if (typeof value === "string" && value.length > 0) return value;
    // Codex and some MCP shells pass argv as a list; joining it is enough to read the head and its paths.
    if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string")) return value.join(" ");
  }
  return null;
}

function stringsOf(toolInput: Readonly<Record<string, unknown>>, fields: readonly string[]): string[] {
  const found: string[] = [];
  for (const field of fields) {
    const value = toolInput[field];
    if (typeof value === "string" && value.length > 0) found.push(value);
    else if (Array.isArray(value)) for (const part of value) if (typeof part === "string" && part.length > 0) found.push(part);
  }
  return found;
}

/**
 * What a tool call searches: "osnova" for osnova's own tools or the osnova CLI, the targets of a search, or
 * undefined when the gate has nothing to say about the call. An MCP proxy tool (Pi's adapter) counts as osnova
 * when its arguments name an osnova tool.
 */
export function gateSubject(toolName: string, toolInput: Readonly<Record<string, unknown>>, cwd: string, serverName?: string): "osnova" | GateTarget[] | undefined {
  if (isOsnovaToolName(toolName) || isOsnovaToolName(serverName) || (/mcp/i.test(toolName) && /\bosnova_\w+/.test(JSON.stringify(toolInput)))) return "osnova";
  const command = shellCommandOf(toolInput);
  if (command !== null) return scanShellCommand(command, cwd);
  const tool = toolName.toLowerCase();
  if (!searchToolNames.has(tool)) return undefined;
  const filter = stringsOf(toolInput, ["glob", "include", ...(fileGlobTools.has(tool) ? ["pattern"] : [])])[0];
  const given = stringsOf(toolInput, pathFields);
  return (given.length > 0 ? given.map((value) => expandPath(value, cwd)) : [cwd]).map((target) => ({ path: target, filter }));
}

// A target reaches code when an indexed file in a code language lies at or under it and, with a filter, matches it.
// A file osnova keeps only as text (data, prose, configuration) never counts, nor does a path outside the workspace.
export function reachesCode(index: OsnovaIndex, workspace: string, target: GateTarget): boolean {
  const relative = path.relative(workspace, target.path).split(path.sep).join("/");
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return false;
  const filter = target.filter?.replace(/^\.\//, "");
  const matches = filter === undefined ? undefined : globPattern(filter);
  for (const card of index.files.values()) {
    if (card.language === "fallback") continue;
    if (relative !== "" && card.path !== relative && !card.path.startsWith(`${relative}/`)) continue;
    if (matches === undefined) return true;
    const below = relative === "" || card.path === relative ? card.path : card.path.slice(relative.length + 1);
    if (matches.test(filter!.includes("/") ? below : path.posix.basename(card.path))) return true;
  }
  return false;
}

function globPattern(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === "*" && glob[i + 1] === "*") { const slash = glob[i + 2] === "/"; source += slash ? "(?:.*/)?" : ".*"; i += slash ? 2 : 1; }
    else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{") source += "(?:";
    else if (char === "}") source += ")";
    else if (char === ",") source += "|";
    else source += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export const gateReason = "[osnova gate] This search reaches code that osnova indexes. Use the osnova tools first: osnova_footing (task context), osnova_ground (definitions), osnova_thread (regex over indexed text), osnova_outline (one file), osnova_warp (callers and callees). If those tools are not available here, the osnova CLI counts too (osnova footing \"<question>\"). After an osnova call this turn, plain search runs again. Files osnova does not index as code are never gated.";

// The deny each client reads. Claude Code and Codex take the nested PreToolUse object (Codex accepts deny and
// rejects allow and ask there); Cursor reads a flat object with a message for the user and one for the agent.
export function gateDenyPayload(client: "claude-code" | "codex" | "cursor"): unknown {
  if (client === "cursor") return { permission: "deny", user_message: "osnova: search the index first", agent_message: gateReason };
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: gateReason } };
}

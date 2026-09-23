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

/** The osnova MCP tools under both install forms: `mcp__osnova__*` and any plugin-scoped prefix. */
export function isOsnovaToolName(name: string | undefined): boolean {
  return name !== undefined && /^mcp__[^_]*_*.*osnova.*__/i.test(name);
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

// Only the command that opens a pipeline stage is a search. `git status | grep x` filters output that
// is already in hand, so it is never gated.
export function scanShellCommand(command: string, cwd: string): ShellScan {
  const searches: string[][] = [];
  let usedOsnova = false;
  for (const chain of command.split(/&&|\|\||;|\n/)) {
    const words = chain.split(/\|/)[0]!.trim().split(/\s+/).filter((word) => word.length > 0);
    while (words.length > 0 && wrapperWords.test(words[0]!)) words.shift();
    if (words.length === 0) continue;
    const head = path.basename(words[0]!);
    if (head === "osnova") usedOsnova = true;
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

/** What this tool call searches, or null when the gate has nothing to say about it. */
export function gateSubject(request: GateRequest): GateSubject | null {
  const { toolName, toolInput, cwd } = request;
  if (toolName === "Grep" || toolName === "Glob") {
    const given = toolInput?.path;
    const target = typeof given === "string" && given.length > 0 ? expandPath(given, cwd) : cwd;
    return { targets: [target], usedOsnova: false, label: toolName };
  }
  if (toolName !== "Bash") return null;
  const command = toolInput?.command;
  if (typeof command !== "string") return null;
  const { searches, usedOsnova } = scanShellCommand(command, cwd);
  if (searches.length === 0) return { targets: [], usedOsnova, label: "grep/rg/find" };
  return { targets: searches.flatMap((paths) => (paths.length > 0 ? [...paths] : [cwd])), usedOsnova, label: "grep/rg/find" };
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

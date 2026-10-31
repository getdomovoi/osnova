import os from "node:os";
import path from "node:path";
import type { OsnovaIndex } from "../types.js";

// The search gate's decision: what a tool call searches, and whether that reaches code osnova indexes. Turn
// state and output live in the hook; this module reads a call and an index and nothing else.

const searchCommands = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "fd", "find"]);
// Words that stand in front of the command being run and are not the command itself, shell keywords included, so
// `if rg …`, `then rg …`, `do grep …` and `! rg …` are read as the search behind them.
const wrapperWords = /^(?:\w+=\S*|sudo|command|exec|time|env|nice|nohup|xargs|if|then|else|elif|do|while|until|!)$/;
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
  /** Unquoted `(` that open a subshell in this stage, and `)` that close one. */
  readonly opens: number;
  readonly closes: number;
}

// Splitting on `|` with a regular expression cuts `grep -nE "FAIL|error" notes.txt` in half and loses the
// path, which then reads as a search of the whole workspace. The separators only count outside quotes, and so do
// the parentheses of a subshell; a `$( … )` substitution stays inside its word.
export function shellStages(command: string): Stage[] {
  const stages: Stage[] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let afterPipe = false;
  let opens = 0, closes = 0, substitution = 0;
  let quote: "'" | "\"" | null = null;
  const endWord = (): void => { if (started) { words.push(word); word = ""; started = false; } };
  const endStage = (nextAfterPipe: boolean): void => { endWord(); if (words.length > 0 || opens > 0 || closes > 0) stages.push({ words, afterPipe, opens, closes }); words = []; afterPipe = nextAfterPipe; opens = 0; closes = 0; };
  for (let i = 0; i < command.length; i += 1) {
    const character = command[i]!;
    if (quote !== null) {
      if (character === quote) quote = null; else { word += character; started = true; }
      continue;
    }
    if (character === "'" || character === "\"") { quote = character; started = true; continue; }
    // A backslash escapes only a character the shell would otherwise act on, so `C:\Users\me\notes.txt` stays one path.
    if (character === "\\" && i + 1 < command.length && shellEscapable.test(command[i + 1]!)) { word += command[i + 1]!; started = true; i += 1; continue; }
    if (character === "(" && word.endsWith("$")) { substitution += 1; word += character; continue; }
    if (character === ")" && substitution > 0) { substitution -= 1; word += character; continue; }
    if (substitution > 0) { word += character; started = true; continue; }
    if (character === "(") { endWord(); opens += 1; continue; }
    if (character === ")") { endWord(); closes += 1; continue; }
    // `||` ends a stage that the next one does not read; `|` and `|&` pipe its output into the next stage.
    if (character === "|") { const double = command[i + 1] === "|"; endStage(!double); if (double || command[i + 1] === "&") i += 1; continue; }
    if (character === "&") { if (command[i + 1] === "&") i += 1; endStage(false); continue; }
    if (character === ";" || character === "\n") { endStage(false); continue; }
    if (/\s/.test(character)) { endWord(); continue; }
    word += character; started = true;
  }
  endStage(false);
  return stages;
}

// Only the command that opens a pipeline stage is a search: `git status | grep x` filters output already in hand.
// `cd` moves the folder later stages search; a `( … )` subshell restores it when it closes. A variable the command
// sets with `NAME=value` is expanded; a path that still holds an unknown variable cannot be known, so it targets
// nothing, and a search or a `cd` into it lets the call through as any unreadable call does. A shell started with
// `-c` is read for the command it runs. Any stage that runs the osnova CLI counts as using osnova.
const assignment = /^([A-Za-z_]\w*)=(.*)$/s;
const shells = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
function scanShellCommand(command: string, cwd: string, depth = 0): "osnova" | GateTarget[] | undefined {
  const targets: GateTarget[] = [];
  // A variable assigned from one this command does not set is known to exist but not its value: undefined.
  const variables = new Map<string, string | undefined>();
  const outer: (string | undefined)[] = [];
  let here: string | undefined = cwd;
  let searched = false;
  const readStage = (stageWords: readonly string[], afterPipe: boolean): "osnova" | undefined => {
    const assigned = stageWords.findIndex((word) => !assignment.test(word));
    if (assigned === -1) { for (const word of stageWords) { const [, name, value] = assignment.exec(word)!; variables.set(name!, expandVariables(value!, variables)); } return undefined; }
    const words = stageWords.slice(assigned);
    while (words.length > 0 && wrapperWords.test(words[0]!)) words.shift();
    if (words.length === 0) return undefined;
    if (runsOsnova(words)) return "osnova";
    if (afterPipe) return undefined;
    const head = path.basename(words[0]!);
    if (shells.has(head)) {
      const flag = words.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word));
      const inner = flag > 0 && words[flag + 1] !== undefined && depth < 3 && here !== undefined ? scanShellCommand(words[flag + 1]!, here, depth + 1) : undefined;
      if (inner === "osnova") return "osnova";
      if (inner !== undefined) { searched = true; targets.push(...inner); }
      return undefined;
    }
    const expanded = words.map((word) => expandVariables(word, variables));
    if (head === "cd") { const to = words[1] === undefined ? "~" : expanded[1]; here = here === undefined || to === undefined ? undefined : expandPath(to, here); return undefined; }
    const git = head === "git" && words[1] === "grep";
    if (!git && !searchCommands.has(head)) return undefined;
    searched = true;
    if (here === undefined) return undefined;
    const { paths, unknown } = searchOperands(git ? "grep" : head, expanded.slice(git ? 2 : 1));
    targets.push(...(paths.length > 0 ? paths.map((target) => expandPath(target, here!)) : unknown ? [] : [here]).map((target) => ({ path: target })));
    return undefined;
  };
  for (const stage of shellStages(command)) {
    for (let level = 0; level < stage.opens; level += 1) outer.push(here);
    const words = stage.words.filter((word) => word !== "{" && word !== "}");
    if (words.length > 0 && readStage(words, stage.afterPipe) === "osnova") return "osnova";
    for (let level = 0; level < stage.closes && outer.length > 0; level += 1) here = outer.pop();
  }
  return searched ? targets : undefined;
}

// `$NAME` and `${NAME}` from the command's own assignments; undefined when such a variable is not known here or was
// assigned from one that is not. A `$` that starts no variable name, as in the regex `'total$'`, stays as written.
function expandVariables(word: string, variables: ReadonlyMap<string, string | undefined>): string | undefined {
  let unknown = false;
  const result = word.replace(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (_match, braced: string | undefined, bare: string | undefined) => {
    const value = variables.get((braced ?? bare)!);
    if (value === undefined) unknown = true;
    return value ?? "";
  });
  return unknown ? undefined : result;
}

// Each tool's grammar: the options whose value is the next word, the options that give the pattern (so every
// operand is a path), and the list-only modes that take no pattern at all. One shared table read grep's `-E`, a
// plain flag, as rg's `-E ENCODING` and lost the pattern.
interface SearchGrammar { readonly values: ReadonlySet<string>; readonly givesPattern: ReadonlySet<string>; readonly listsFiles: ReadonlySet<string> }
const grammar = (values: string, givesPattern: string, listsFiles = ""): SearchGrammar => ({ values: new Set(values.split(" ")), givesPattern: new Set(givesPattern.split(" ")), listsFiles: new Set(listsFiles.split(" ").filter((flag) => flag.length > 0)) });
const grepGrammar = grammar("-e -f -A -B -C -m -d -D --regexp --file --context --after-context --before-context --max-count --include --exclude --exclude-dir --label --binary-files --devices --directories", "-e -f --regexp --file");
const grammars: Readonly<Record<string, SearchGrammar>> = {
  grep: grepGrammar, egrep: grepGrammar, fgrep: grepGrammar,
  rg: grammar("-e -f -A -B -C -m -g -t -T -j -M -E -r --regexp --file --glob --iglob --type --type-not --type-add --max-count --max-depth --threads --max-columns --encoding --replace --context --after-context --before-context --ignore-file --pre --pre-glob --sort --sortr --max-filesize --engine --color --colors", "-e -f --regexp --file", "--files --type-list"),
  ag: grammar("-A -B -C -G -m -g -p --context --after --before --depth --max-count --ignore --ignore-dir --file-search-regex --path-to-ignore --pager", "-g --file-search-regex"),
  ack: grammar("-A -B -C -m -g --type --ignore-dir --ignore-file --match --context --after-context --before-context --max-count --output", "-g --match", "-f"),
  fd: grammar("-e -E -t -d -x -X -j -c -S --extension --exclude --type --max-depth --min-depth --exact-depth --exec --exec-batch --threads --color --changed-within --changed-before --size --owner --base-directory --max-results", ""),
};

// The paths a search reads, by its own grammar: find takes paths before its expression; fd, grep, rg, ag and ack take
// a pattern first, unless an option gives it or a list-only mode needs none, then paths. A path operand that holds an
// unknown variable is left out and reported, so the search is not read as one of the working directory.
function searchOperands(head: string, args: readonly (string | undefined)[]): { paths: string[]; unknown: boolean } {
  const rules = grammars[head];
  const operands: (string | undefined)[] = [];
  let patternGiven = head === "find";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) { operands.push(undefined); continue; }
    if (arg === "--") { operands.push(...args.slice(i + 1)); break; }
    if (head === "find" && (arg.startsWith("-") || arg === "!" || arg === "(")) break;
    if (!arg.startsWith("-") || arg === "-") { operands.push(arg); continue; }
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (rules?.givesPattern.has(flag) === true || rules?.listsFiles.has(flag) === true) patternGiven = true;
    if (!arg.includes("=") && rules?.values.has(flag) === true) i += 1;
  }
  const paths = patternGiven ? operands : operands.slice(1);
  return { paths: paths.filter((value): value is string => value !== undefined), unknown: paths.some((value) => value === undefined) };
}

// The osnova CLI, run directly or through npx, bunx, pnpx, `pnpm exec`, `pnpm dlx`, `yarn exec`, `bun x`, or a
// runtime given the CLI's own script (`…/osnova/dist/bin.js`, `…/node_modules/.bin/osnova`). Another script that only
// lives in a folder named osnova, such as this repository's own scripts, is not a run of the CLI, nor is a grep for
// the word.
const packageRunners = new Set(["npx", "bunx", "pnpx"]);
const osnovaScript = /(?:^|[\\/])osnova[\\/]dist[\\/](?:bin|cli)\.m?js$|(?:^|[\\/])osnova$/;
function runsOsnova(words: readonly string[]): boolean {
  const launcher = path.basename(words[0]!);
  let index = 0;
  let script = false;
  if (packageRunners.has(launcher)) index = 1;
  else if ((launcher === "pnpm" || launcher === "yarn" || launcher === "bun") && ["exec", "dlx", "x"].includes(words[1] ?? "")) index = 2;
  else if (launcher === "node" || launcher === "bun" || launcher === "tsx" || launcher === "deno") { index = 1; script = true; }
  while (words[index]?.startsWith("-") === true) index += 1;
  const target = words[index];
  if (target === undefined) return false;
  if (script) return osnovaScript.test(target);
  return path.posix.basename(target.replace(/(?<=.)@[^/@]*$/, "")) === "osnova";
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
    // Codex and some MCP shells pass argv as a list, such as ["bash", "-lc", "rg foo src"]; each part is quoted so
    // the command a shell runs stays one word.
    if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string")) return value.map((part: string) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`)).join(" ");
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
  // A shell call's own working folder (Codex's `workdir`) decides where it searches.
  if (command !== null) return scanShellCommand(command, expandPath(stringsOf(toolInput, ["workdir", "cwd", "dir", "directory"])[0] ?? ".", cwd));
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

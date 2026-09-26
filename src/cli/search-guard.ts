// The search guard behind `osnova hook search`: read a Grep or Bash tool call, decide whether it is a
// hunt for code names the index already answers, and build that answer. Everything here is pure; the
// hook wiring, the index and the per-session state live in hook.ts.
//
// A call is guarded only when it is certainly one repository search: argv is split the way a shell
// would, a pipe filter over another command's output is not a repository search, a variable or a
// command substitution makes the target unknown, and a command that does other work besides the search
// runs untouched. Any doubt lets the search run.

export interface SearchCall {
  readonly patterns: readonly string[];
  /** Path arguments as written; empty means the tool's default, the working directory. */
  readonly paths: readonly string[];
  /** A directory a leading `cd` moved to before the search, as written. */
  readonly base: string;
  /** "lines" prints matching lines; "other" is a file list, a count, a quiet check or lines with context, which a graph answer does not replace. */
  readonly shape: "lines" | "other";
  /** The line cap of a `head` the output is piped through, when there is one. */
  readonly maxLines?: number | undefined;
  /** How the search reads its patterns, so the hook can count what it would print. */
  readonly syntax: "basic" | "extended" | "fixed";
  readonly ignoreCase: boolean;
  readonly word: boolean;
}

interface Word { readonly text: string; readonly dynamic: boolean }
type Token = { readonly kind: "word"; readonly word: Word } | { readonly kind: "op"; readonly op: string };

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Shell words and control operators. Returns null for anything this reader does not model exactly:
// subshells, heredocs, unterminated quotes.
function tokenize(command: string): Token[] | null {
  const tokens: Token[] = [];
  let text = "", dynamic = false, inWord = false;
  const flush = (): void => { if (inWord) tokens.push({ kind: "word", word: { text, dynamic } }); text = ""; dynamic = false; inWord = false; };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]!;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      text += command.slice(i + 1, end); inWord = true; i = end; continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j += 1) {
        const d = command[j]!;
        if (d === "\\" && j + 1 < command.length && '"\\$`'.includes(command[j + 1]!)) { text += command[j + 1]; j += 1; continue; }
        if (d === "$" || d === "`") dynamic = true;
        text += d;
      }
      if (j >= command.length) return null;
      inWord = true; i = j; continue;
    }
    if (c === "\\") { if (i + 1 < command.length) { text += command[i + 1]; i += 1; inWord = true; } continue; }
    if (c === "$" || c === "`") { dynamic = true; text += c; inWord = true; continue; }
    if (c === "(" || c === ")" || c === "{" && !inWord) return null;
    if (c === " " || c === "\t") { flush(); continue; }
    if (c === "\n" || c === ";") { flush(); tokens.push({ kind: "op", op: ";" }); continue; }
    if (c === "|" || c === "&") {
      flush();
      const two = command.slice(i, i + 2);
      if (two === "||" || two === "&&") { tokens.push({ kind: "op", op: two }); i += 1; continue; }
      if (c === "&") { if (command[i + 1] === ">") { i += 1; tokens.push({ kind: "op", op: "redirect" }); continue; } tokens.push({ kind: "op", op: ";" }); continue; }
      tokens.push({ kind: "op", op: "|" }); continue;
    }
    if (c === ">" || c === "<") {
      if (command.slice(i, i + 2) === "<<") return null;
      // A redirection: drop a leading descriptor digit already read into this word, then the operator and its target.
      if (/^\d$/.test(text) && inWord) { text = ""; inWord = false; } else flush();
      let j = i + 1;
      while (command[j] === ">" || command[j] === "&") j += 1;
      tokens.push({ kind: "op", op: "redirect" }); i = j - 1; continue;
    }
    text += c; inWord = true;
  }
  flush();
  return tokens;
}

type Simple = readonly Word[];
interface Pipeline { readonly commands: readonly Simple[] }

// Split tokens into pipelines of simple commands, dropping redirections with their targets.
function pipelines(tokens: readonly Token[]): Pipeline[] {
  const result: Pipeline[] = [];
  let commands: Simple[] = [], words: Word[] = [], skipNext = false;
  const endCommand = (): void => { if (words.length > 0) commands.push(words); words = []; };
  const endPipeline = (): void => { endCommand(); if (commands.length > 0) result.push({ commands }); commands = []; };
  for (const token of tokens) {
    if (token.kind === "word") { if (skipNext) { skipNext = false; continue; } words.push(token.word); continue; }
    if (token.op === "redirect") { skipNext = true; continue; }
    if (token.op === "|") endCommand(); else endPipeline();
  }
  endPipeline();
  return result;
}

const wrappers = new Set(["time", "command", "nohup"]);
// Commands that only shape a search's output when they follow it in a pipe.
const outputFilters = new Set(["head", "tail", "sort", "uniq", "wc", "cut", "tr", "grep", "rg", "awk", "sed", "column", "cat", "less", "more", "nl", "fold"]);

// Strip wrappers that do not change what runs: assignments, env, time, nice, command.
function unwrap(words: Simple): Simple | null {
  let rest = [...words];
  for (;;) {
    const head = rest[0];
    if (head === undefined) return rest;
    if (head.dynamic) return null;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head.text)) { rest = rest.slice(1); continue; }
    if (head.text === "env") {
      rest = rest.slice(1);
      while (rest[0] !== undefined && (rest[0].text.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0].text))) rest = rest.slice(rest[0].text === "-u" ? 2 : 1);
      continue;
    }
    if (head.text === "nice") { rest = rest.slice(rest[1]?.text === "-n" ? 3 : 1); continue; }
    if (wrappers.has(head.text)) { rest = rest.slice(1); continue; }
    return rest;
  }
}

interface ToolSpec { readonly valueFlags: RegExp; readonly longValueFlags: ReadonlySet<string>; readonly recursiveByDefault: boolean }
const rgSpec: ToolSpec = {
  valueFlags: /[efgtTmABCdjMrE]/,
  longValueFlags: new Set(["regexp", "file", "glob", "iglob", "type", "type-not", "max-count", "after-context", "before-context", "context", "max-depth", "max-filesize", "threads", "sort", "sortr", "color", "colors", "max-columns", "path-separator", "encoding", "pre", "pre-glob", "engine", "type-add", "type-clear", "ignore-file", "replace", "context-separator", "field-context-separator", "field-match-separator"]),
  recursiveByDefault: true,
};
const grepSpec: ToolSpec = {
  valueFlags: /[efmABCdD]/,
  longValueFlags: new Set(["regexp", "file", "max-count", "after-context", "before-context", "context", "include", "exclude", "exclude-dir", "exclude-from", "color", "colour", "directories", "devices", "label", "binary-files", "group-separator"]),
  recursiveByDefault: false,
};

// One search command's patterns and paths, or null when its target cannot be known.
// Flags that make the output something other than the matching lines themselves.
const otherShapeShort = /[lLcqoABC]/;
const otherShapeLong = new Set(["files-with-matches", "files-without-match", "count", "count-matches", "quiet", "only-matching", "files", "context", "after-context", "before-context"]);

type ReadSearch = { patterns: string[]; paths: string[]; shape: "lines" | "other"; syntax: "basic" | "extended" | "fixed"; ignoreCase: boolean; word: boolean };
function readSearch(words: Simple): ReadSearch | null {
  let args = words.map((word) => word);
  const tool = args[0]?.text;
  let spec: ToolSpec;
  if (tool === "rg" || tool === "ag" || tool === "ack") spec = rgSpec;
  else if (tool === "grep" || tool === "egrep" || tool === "fgrep") spec = grepSpec;
  else if (tool === "git" && args[1]?.text === "grep") { spec = { ...grepSpec, recursiveByDefault: true }; args = args.slice(1); }
  else return null;
  let recursive = spec.recursiveByDefault;
  let shape: "lines" | "other" = "lines";
  // grep and git grep read basic regular expressions unless -E, -P or -F; rg, ag and ack read extended ones.
  let syntax: "basic" | "extended" | "fixed" = spec === rgSpec ? "extended" : tool === "egrep" ? "extended" : tool === "fgrep" ? "fixed" : "basic";
  let ignoreCase = false, wholeWord = false;
  const patterns: string[] = [], positional: Word[] = [];
  let endOfFlags = false;
  for (let i = 1; i < args.length; i += 1) {
    const word = args[i]!;
    if (word.dynamic) return null;
    const text = word.text;
    if (endOfFlags || !text.startsWith("-") || text === "-") { positional.push(word); continue; }
    if (text === "--") { endOfFlags = true; continue; }
    if (text.startsWith("--")) {
      const [name, inline] = [text.slice(2).split("=")[0]!, text.includes("=") ? text.slice(text.indexOf("=") + 1) : undefined];
      if (name === "file" || name === "files-from") return null;
      if (name === "recursive" || name === "dereference-recursive") recursive = true;
      if (otherShapeLong.has(name)) shape = "other";
      if (name === "fixed-strings") syntax = "fixed";
      if (name === "extended-regexp" || name === "perl-regexp") syntax = "extended";
      if (name === "ignore-case") ignoreCase = true;
      if (name === "word-regexp") wholeWord = true;
      if (spec.longValueFlags.has(name)) {
        const value = inline ?? args[++i]?.text;
        if (value === undefined || args[i]?.dynamic === true) return null;
        if (name === "regexp") patterns.push(value);
      }
      continue;
    }
    for (let j = 1; j < text.length; j += 1) {
      const flag = text[j]!;
      if (spec === grepSpec && (flag === "r" || flag === "R")) recursive = true;
      if (otherShapeShort.test(flag)) shape = "other";
      if (flag === "F") syntax = "fixed";
      if ((flag === "E" && spec === grepSpec) || flag === "P") syntax = "extended";
      if (flag === "i") ignoreCase = true;
      if (flag === "w") wholeWord = true;
      if (!spec.valueFlags.test(flag)) continue;
      const attached = text.slice(j + 1);
      const value = attached.length > 0 ? attached : args[++i]?.text;
      if (value === undefined || (attached.length === 0 && args[i]?.dynamic === true)) return null;
      if (flag === "f") return null;
      if (flag === "e") patterns.push(value);
      break;
    }
  }
  if (patterns.length === 0) {
    const first = positional.shift();
    if (first === undefined) return null;
    patterns.push(first.text);
  }
  if (positional.length === 0 && !recursive) return null;
  return { patterns, paths: positional.map((item) => item.text), shape, syntax, ignoreCase, word: wholeWord };
}

export function parseSearchCall(toolName: string | undefined, toolInput: Readonly<Record<string, unknown>> | undefined): SearchCall | null {
  if (toolInput === undefined) return null;
  if (toolName === "Grep" || toolName === "grep") {
    if (typeof toolInput.pattern !== "string" || toolInput.pattern.length === 0) return null;
    const where = typeof toolInput.path === "string" && toolInput.path.length > 0 ? [toolInput.path] : [];
    // The Grep tool lists files unless asked for content, and context keys ask for surrounding lines.
    const context = ["-A", "-B", "-C", "context"].some((key) => toolInput[key] !== undefined);
    // Claude Code's Grep lists files unless output_mode is content; the OpenCode and Kilo grep tool prints matching lines.
    const shape = !context && (toolName === "grep" || toolInput.output_mode === "content") ? "lines" : "other";
    return { patterns: [toolInput.pattern], paths: where, base: "", shape, syntax: "extended", ignoreCase: toolInput["-i"] === true, word: false };
  }
  if ((toolName !== "Bash" && toolName !== "bash") || typeof toolInput.command !== "string") return null;
  return parseCommand(toolInput.command, 0);
}

function parseCommand(command: string, depth: number): SearchCall | null {
  if (depth > 2) return null;
  const tokens = tokenize(command);
  if (tokens === null) return null;
  let base = "", found: SearchCall | null = null;
  for (const pipeline of pipelines(tokens)) {
    const first = pipeline.commands[0] === undefined ? null : unwrap(pipeline.commands[0]);
    if (first === null || first.length === 0) return null;
    // A leading cd before the search moves where the search runs; after it, a cd is other work.
    if (first[0]!.text === "cd" && pipeline.commands.length === 1 && found === null) {
      if (first.length > 2 || first[1]?.dynamic === true) return null;
      base = first[1]?.text ?? ""; continue;
    }
    if (found !== null) return null;
    const shell = /^(?:ba|z|da)?sh$/.test(first[0]!.text) ? first : null;
    if (shell !== null) {
      const flags = shell.slice(1, -1).map((word) => word.text);
      const script = shell.at(-1);
      if (pipeline.commands.length !== 1 || script === undefined || script.dynamic || !flags.some((flag) => /^-[a-z]*c[a-z]*$/.test(flag))) return null;
      const inner = parseCommand(script.text, depth + 1);
      if (inner === null) return null;
      found = inner; continue;
    }
    const search = readSearch(first);
    if (search === null) return null;
    let maxLines: number | undefined;
    for (const [position, later] of pipeline.commands.slice(1).entries()) {
      const filter = unwrap(later);
      if (filter === null || filter[0] === undefined || !outputFilters.has(filter[0].text)) return null;
      if (position === 0 && filter[0].text === "head") maxLines = headLines(filter.slice(1).map((word) => word.text));
    }
    found = { ...search, base, ...(maxLines === undefined ? {} : { maxLines }) };
  }
  return found;
}

// One JavaScript regular expression that matches the lines the search would print, or null when the
// patterns do not translate. Basic syntax swaps the escaped and bare forms of ( ) { } + ? |.
export function searchRegExp(call: SearchCall): RegExp | null {
  const translate = (pattern: string): string => {
    if (call.syntax === "fixed") return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (call.syntax === "extended") return pattern;
    let out = "";
    for (let i = 0; i < pattern.length; i += 1) {
      const c = pattern[i]!;
      if (c === "\\" && i + 1 < pattern.length && "(){}+?|".includes(pattern[i + 1]!)) { out += pattern[i + 1]; i += 1; continue; }
      if ("(){}+?|".includes(c)) { out += `\\${c}`; continue; }
      if (c === "\\" && i + 1 < pattern.length) { out += c + pattern[i + 1]; i += 1; continue; }
      out += c;
    }
    return out;
  };
  const body = call.patterns.map((pattern) => `(?:${translate(pattern)})`).join("|");
  try {
    return new RegExp(call.word ? `\\b(?:${body})\\b` : body, call.ignoreCase ? "i" : "");
  } catch {
    return null;
  }
}

// `head -20`, `head -n 20`, `head -n20`, `head --lines=20`; the default is 10.
function headLines(args: readonly string[]): number | undefined {
  if (args.length === 0) return 10;
  const joined = args.join(" ");
  const match = /^(?:-(\d+)|-n\s*(\d+)|--lines=(\d+))$/.exec(joined);
  return match === null ? undefined : Number(match[1] ?? match[2] ?? match[3]);
}

// The code names a set of patterns hunts for, or null when any alternative is anything but a name:
// quoted text, prose, a regex wider than one identifier. `def foo\|foo(`, `\bFoo\b` and `\.invoke\(`
// are the shapes an agent greps a definition or its call sites with.
const namePrefix = /^(?:(?:\\b|\\<|\^|\\s\*|\\s\+|\s)+)?(?:(?:def|function|class|func|fn|interface|type|const|let|var|export|async|import|from|new|struct|enum|trait|impl|pub|static|private|public|protected|override|readonly)(?:\\s\+|\\s\*|\s)+)*(?:self|this|cls)?(?:\\\.|\.|->|::)?/;
const nameSuffix = /(?:\\b|\\>|\$|(?:\\s\*|\\s\+|\s)*(?:\\\(|\(|=|:|\\\[|<))*$/;
export function symbolHuntNames(patterns: readonly string[]): string[] | null {
  const names = new Set<string>();
  for (const pattern of patterns) {
    if (/["'`]/.test(pattern)) return null;
    for (const alternative of pattern.split(/\\\||\|/)) {
      const bare = alternative.trim().replace(namePrefix, "").replace(nameSuffix, "");
      if (bare.length < 3 || !identifier.test(bare)) return null;
      names.add(bare);
    }
  }
  return names.size === 0 ? null : [...names].sort();
}

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
function readSearch(words: Simple): { patterns: string[]; paths: string[] } | null {
  let args = words.map((word) => word);
  const tool = args[0]?.text;
  let spec: ToolSpec;
  if (tool === "rg" || tool === "ag" || tool === "ack") spec = rgSpec;
  else if (tool === "grep" || tool === "egrep" || tool === "fgrep") spec = grepSpec;
  else if (tool === "git" && args[1]?.text === "grep") { spec = { ...grepSpec, recursiveByDefault: true }; args = args.slice(1); }
  else return null;
  let recursive = spec.recursiveByDefault;
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
  return { patterns, paths: positional.map((word) => word.text) };
}

export function parseSearchCall(toolName: string | undefined, toolInput: Readonly<Record<string, unknown>> | undefined): SearchCall | null {
  if (toolInput === undefined) return null;
  if (toolName === "Grep" || toolName === "grep") {
    if (typeof toolInput.pattern !== "string" || toolInput.pattern.length === 0) return null;
    const where = typeof toolInput.path === "string" && toolInput.path.length > 0 ? [toolInput.path] : [];
    return { patterns: [toolInput.pattern], paths: where, base: "" };
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
    for (const later of pipeline.commands.slice(1)) {
      const filter = unwrap(later);
      if (filter === null || filter[0] === undefined || !outputFilters.has(filter[0].text)) return null;
    }
    found = { ...search, base };
  }
  return found;
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

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type SetupClientId = "claude-code" | "codex" | "opencode" | "kilo" | "cursor" | "pi";
type Shape = "mcpServers" | "opencode" | "codex-toml";

export interface SetupClient {
  readonly id: SetupClientId;
  readonly name: string;
  readonly shape: Shape;
  readonly configPath: (home: string) => string;
  readonly alternates?: readonly ((home: string) => string)[];
}

export const setupClients: readonly SetupClient[] = [
  { id: "claude-code", name: "Claude Code", shape: "mcpServers", configPath: (home) => path.join(home, ".claude.json") },
  { id: "codex", name: "Codex", shape: "codex-toml", configPath: (home) => path.join(home, ".codex", "config.toml") },
  { id: "opencode", name: "OpenCode", shape: "opencode", configPath: (home) => path.join(home, ".config", "opencode", "opencode.json"),
    alternates: [(home) => path.join(home, ".config", "opencode", "opencode.jsonc")] },
  { id: "kilo", name: "Kilo", shape: "opencode", configPath: (home) => path.join(home, ".config", "kilo", "kilo.jsonc"),
    alternates: [(home) => path.join(home, ".config", "kilo", "kilo.json")] },
  { id: "cursor", name: "Cursor", shape: "mcpServers", configPath: (home) => path.join(home, ".cursor", "mcp.json") },
  { id: "pi", name: "Pi (pi-mcp-adapter)", shape: "mcpServers", configPath: (home) => path.join(home, ".pi", "agent", "mcp.json") },
];

export interface SetupPreviewOptions {
  readonly home?: string | undefined;
  readonly configPath?: string | undefined;
  readonly command?: readonly string[] | undefined;
}

export interface SetupPreview {
  readonly mode: "preview";
  readonly client: SetupClientId;
  readonly path: string;
  readonly action: "create" | "append" | "update" | "unchanged" | "conflict";
  readonly diff: string;
  readonly merged: string;
  readonly notice: string;
}

const maximumConfigBytes = 1_048_576;

export async function previewSetup(client: SetupClientId, options: SetupPreviewOptions = {}): Promise<SetupPreview> {
  const spec = setupClients.find((candidate) => candidate.id === client);
  if (spec === undefined) throw new Error(`osnova setup: unknown client ${JSON.stringify(client)}; known: ${setupClients.map((c) => c.id).join(", ")}`);
  const home = path.resolve(options.home ?? os.homedir());
  const command = options.command ?? ["osnova"];
  if (command.length === 0 || command.some((part) => typeof part !== "string" || part.length === 0)) throw new Error("osnova setup: command must be a non-empty list of non-empty strings");
  let target = options.configPath === undefined ? spec.configPath(home) : path.resolve(options.configPath);
  if (options.configPath === undefined) {
    for (const alternate of [spec.configPath, ...(spec.alternates ?? [])]) {
      const candidate = alternate(home);
      if (await exists(candidate)) { target = candidate; break; }
    }
  }
  const relative = path.relative(home, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`osnova setup: config path must be inside the home directory ${home}`);
  const existing = await readExisting(target);
  const result = spec.shape === "codex-toml" ? mergeToml(existing, command) : mergeJson(existing, spec.shape, command);
  const action: SetupPreview["action"] = existing === null ? "create" : result.state;
  const diff = action === "create" || action === "append" || action === "update" ? unifiedDiff(target, existing ?? "", result.merged) : "";
  const notice = action === "conflict"
    ? `${target} already has an osnova entry that does not launch osnova; osnova never edits it. Compare by hand.`
    : action === "unchanged" ? `${target} already contains this entry.`
    : action === "update" ? `The osnova entry in ${target} is repointed at ${command.join(" ")}; flags after mcp and every other key are kept.`
    : `osnova never applies this change. Review the diff, then paste it into ${target} yourself.`;
  return { mode: "preview", client, path: target, action, diff, merged: result.merged, notice };
}

export interface SetupRemoval {
  readonly client: SetupClientId;
  readonly path: string;
  readonly action: "remove" | "unchanged" | "conflict";
  readonly diff: string;
  readonly merged: string;
  readonly notice: string;
}

// The reverse of previewSetup: the top-level `osnova` MCP entry is cut out of the file's text, with its comma, so
// comments and every other key keep their bytes. Only an entry that launches osnova is removed; one of the same name
// that runs something else is a conflict and stays.
export async function previewRemoval(client: SetupClientId, options: { home?: string | undefined; configPath?: string | undefined } = {}): Promise<SetupRemoval> {
  const spec = setupClients.find((candidate) => candidate.id === client);
  if (spec === undefined) throw new Error(`osnova setup: unknown client ${JSON.stringify(client)}; known: ${setupClients.map((c) => c.id).join(", ")}`);
  const home = path.resolve(options.home ?? os.homedir());
  let target = options.configPath === undefined ? spec.configPath(home) : path.resolve(options.configPath);
  if (options.configPath === undefined) {
    for (const alternate of [spec.configPath, ...(spec.alternates ?? [])]) {
      const candidate = alternate(home);
      if (await exists(candidate)) { target = candidate; break; }
    }
  }
  const relative = path.relative(home, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`osnova setup: config path must be inside the home directory ${home}`);
  const link = await firstLink(target, home);
  if (link !== undefined) return { client, path: target, action: "conflict", diff: "", merged: "", notice: `${link} is a link; osnova never edits a config through a link. Remove the osnova entry by hand.` };
  const existing = await readExisting(target);
  if (existing === null) return { client, path: target, action: "unchanged", diff: "", merged: "", notice: `${target} does not exist.` };
  const result = spec.shape === "codex-toml" ? removeToml(existing) : removeJson(existing, spec.shape);
  const notice = result.reason === "duplicate"
    ? `${target} has more than one osnova entry; osnova never guesses which to remove. Compare by hand.`
    : result.state === "conflict"
    ? `${target} has an osnova entry that does not launch osnova; osnova never edits it. Compare by hand.`
    : result.state === "unchanged" ? `${target} has no osnova entry.` : `The osnova entry is removed from ${target}; every other key is kept.`;
  return { client, path: target, action: result.state === "append" || result.state === "update" ? "remove" : result.state, diff: result.state === "update" ? unifiedDiff(target, existing, result.merged) : "", merged: result.merged, notice };
}

function removeJson(existing: string, shape: Shape): Merge {
  const rootKey = shape === "opencode" ? "mcp" : "mcpServers";
  let parsed: unknown;
  try { parsed = JSON.parse(stripJsonc(existing)); } catch (error) {
    throw new Error(`osnova setup: cannot parse the existing config as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("osnova setup: the existing config is not a JSON object");
  const root = (parsed as Record<string, unknown>)[rootKey];
  const current = root !== null && typeof root === "object" && !Array.isArray(root) ? (root as Record<string, unknown>).osnova : undefined;
  if (current === undefined) return { state: "unchanged", merged: existing };
  if (current === null || typeof current !== "object" || Array.isArray(current)) return { state: "conflict", merged: existing };
  const record = current as Record<string, unknown>;
  const launch = shape === "opencode" ? record.command : [record.command, ...(Array.isArray(record.args) ? record.args : [])];
  if (!Array.isArray(launch) || osnovaLaunchTail(launch) === undefined) return { state: "conflict", merged: existing };
  const parent = locateObject(existing, [rootKey]);
  const plain = stripJsoncKeepingOffsets(existing);
  const top = plain.indexOf("{");
  if (top >= 0 && memberSpans(plain, top, matchingClose(plain, top), rootKey).length > 1) return { state: "conflict", merged: existing, reason: "duplicate" };
  if (parent !== null && memberSpans(plain, parent.open, parent.close, "osnova").length > 1) return { state: "conflict", merged: existing, reason: "duplicate" };
  const member = parent === null ? null : memberSpan(plain, parent.open, parent.close, "osnova");
  if (parent === null || member === null) throw new Error(`osnova setup: cannot locate the ${rootKey}.osnova entry in the existing config`);
  let start = member.start, end = member.end;
  let before = start - 1;
  while (before > parent.open && /\s/.test(plain[before]!)) before--;
  if (plain[before] === ",") start = before;
  else {
    let after = end;
    while (after < parent.close && /\s/.test(plain[after]!)) after++;
    // Past the comma only true whitespace goes; a comment there belongs to the next entry.
    if (plain[after] === ",") { after++; while (after < parent.close && /\s/.test(existing[after]!)) after++; end = after; }
    else { start = parent.open + 1; end = parent.close; }
  }
  return { state: "update", merged: `${existing.slice(0, start)}${existing.slice(end)}` };
}

function memberSpans(text: string, open: number, close: number, key: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let from = open;
  for (;;) {
    const span = memberSpan(text, from, close, key);
    if (span === null) return spans;
    spans.push(span);
    from = span.end;
    while (from < close && /\s/.test(text[from]!)) from++;
    if (text[from] !== ",") return spans;
  }
}

// The first symbolic link among the file and every folder between it and home.
async function firstLink(target: string, home: string): Promise<string | undefined> {
  for (let candidate = target; ; candidate = path.dirname(candidate)) {
    const relative = path.relative(home, candidate);
    if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
    const stat = await fs.lstat(candidate).catch(() => undefined);
    if (stat?.isSymbolicLink() === true) return candidate;
  }
}

// The key's opening quote and the offset just past its value, for a member of the object between `open` and `close`.
function memberSpan(text: string, open: number, close: number, key: string): { start: number; end: number } | null {
  let i = open + 1;
  while (i < close) {
    while (i < close && /[\s,]/.test(text[i]!)) i++;
    if (i >= close || text[i] !== "\"") return null;
    const start = i;
    const nameEnd = stringEnd(text, i);
    const name = JSON.parse(text.slice(i, nameEnd + 1)) as string;
    i = nameEnd + 1;
    while (i < close && /[\s:]/.test(text[i]!)) i++;
    if (text[i] === "{" || text[i] === "[") i = matchingClose(text, i) + 1;
    else while (i < close && text[i] !== "," && text[i] !== "}") i = text[i] === "\"" ? stringEnd(text, i) + 1 : i + 1;
    if (name === key) { let end = i; while (end > start && /\s/.test(text[end - 1]!)) end--; return { start, end }; }
  }
  return null;
}

// The `[mcp_servers.osnova]` table and its `[mcp_servers.osnova.*]` tables, with the blank line setup put before them.
function removeToml(existing: string): Merge {
  const header = /^[ \t]*\[mcp_servers\.osnova\][ \t]*\r?$/m.exec(existing);
  if (header === null) return { state: "unchanged", merged: existing };
  const bodyStart = header.index + header[0].length;
  const next = /^[ \t]*\[(?!mcp_servers\.osnova[.\]])/m.exec(existing.slice(bodyStart));
  const end = next === null ? existing.length : bodyStart + next.index;
  const body = existing.slice(bodyStart, end).split(/^[ \t]*\[/m)[0]!;
  const commandLine = /^[ \t]*command[ \t]*=[ \t]*(".*")[ \t]*\r?$/m.exec(body), argsLine = /^[ \t]*args[ \t]*=[ \t]*(\[.*\])[ \t]*\r?$/m.exec(body);
  if (commandLine === null || argsLine === null) return { state: "conflict", merged: existing };
  let launch: unknown[];
  try { launch = [JSON.parse(commandLine[1]!), ...(JSON.parse(argsLine[1]!) as unknown[])]; } catch { return { state: "conflict", merged: existing }; }
  if (osnovaLaunchTail(launch) === undefined) return { state: "conflict", merged: existing };
  // Comment lines just before the next table describe that table and stay.
  let cut = end;
  if (next !== null) {
    let offset = end;
    const lines = existing.slice(bodyStart, end).split("\n");
    lines.pop();
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!;
      offset -= line.length + 1;
      if (line.trim().startsWith("#")) cut = offset;
      else if (line.trim().length > 0) break;
    }
  }
  // Mid-file, the tables' own trailing blank line goes with them; at the end, the blank line setup put before them does.
  let start = header.index;
  const blank = next === null ? /(\r?\n)\r?\n$/.exec(existing.slice(0, start)) : null;
  if (blank !== null) start -= blank[1]!.length;
  return { state: "update", merged: `${existing.slice(0, start)}${existing.slice(cut)}` };
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

async function readExisting(file: string): Promise<string | null> {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`osnova setup: ${file} is a symbolic link; refusing to preview through it`);
  if (!stat.isFile()) throw new Error(`osnova setup: ${file} is not a regular file`);
  if (stat.size > maximumConfigBytes) throw new Error(`osnova setup: ${file} exceeds the 1 MiB inspection limit`);
  return fs.readFile(file, "utf8");
}

interface Merge { readonly state: "append" | "update" | "unchanged" | "conflict"; readonly merged: string; readonly reason?: "duplicate" | undefined; }

// The program a launch runs is its last part before `mcp` or `hook`. It is osnova's own only when it is the
// `osnova` executable, the `@getdomovoi/osnova` package, or a `dist/bin.js` inside a folder named for osnova; a
// user's script that merely lives under such a folder is not.
// Whether one launch part names osnova's program: the `osnova` executable, the `@getdomovoi/osnova` package, or a
// `dist/bin.js` inside a folder named for osnova. Alone it only recognises osnova inside a shell command, which is
// left as written; ownership needs isOsnovaLauncher.
export function isOsnovaProgram(part: string): boolean {
  // Quotes at either end go, matched or not: inside `bash -c 'osnova hook x'` the word is `'osnova`.
  const program = part.replace(/^["']+|["']+$/g, "").replace(/\\/g, "/");
  const segments = program.split("/");
  const base = segments.at(-1) ?? "";
  return /^osnova(?:\.(?:cmd|exe|js|mjs))?$/.test(base)
    || /^@getdomovoi\/osnova(?:@[^/\s]+)?$/.test(program)
    || (base === "bin.js" && segments.at(-2) === "dist" && segments.slice(0, -2).some((segment) => /osnova/.test(segment)));
}

// A launch is osnova's own only when it is that program alone, or a known runtime running it with only listed flags
// between them, so a command that merely mentions osnova (`echo osnova mcp`) or evaluates code (`node -e osnova`)
// is not.
export function isOsnovaLauncher(parts: readonly string[]): boolean {
  if (!isOsnovaProgram(parts.at(-1) ?? "")) return false;
  if (parts.length === 1) return true;
  const runner = parts[0]!.replace(/^(["'])(.*)\1$/, "$2").replace(/\\/g, "/").split("/").at(-1) ?? "";
  return /^(?:node|nodejs|npx|pnpm|pnpx|bun|bunx|deno)(?:\.(?:exe|cmd))?$/.test(runner)
    && parts.slice(1, -1).every((part) => /^(?:-y|--yes|-q|--quiet|--silent|--no-install|--prefer-offline|--prefer-online|--enable-source-maps|--no-warnings|--no-deprecation|--max-old-space-size=\d+|--stack-size=\d+|dlx|exec|x)$/.test(part));
}

// A hook written as a shell command (`bash -c "cd ~ && node .../dist/bin.js hook prompt"`): the shell's script is
// split on `&&`, `||`, `;`, `|` and newlines, and a segment counts when its words, after `exec` and variable
// assignments, are an osnova launch followed by `hook <name>`. Returns that name; `bash -c 'echo osnova hook x'` gets
// none. Such a hook counts as present for setup and is reported by uninstall, but is never rewritten or removed.
export function shellWrappedOsnovaHook(command: string): string | undefined {
  const match = /^\s*["']?([^\s"']+)["']?\s+-\w*c\s+(["'])([\s\S]*)\2\s*$/.exec(command);
  if (match === null) return undefined;
  const shell = match[1]!.replace(/\\/g, "/").split("/").at(-1) ?? "";
  if (!/^(?:bash|sh|zsh|fish|dash|ksh|pwsh|powershell)(?:\.exe)?$/i.test(shell)) return undefined;
  for (const segment of match[3]!.split(/&&|\|\||;|\||\n/)) {
    const words: string[] = [...(segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [])];
    while (words.length > 0 && (words[0] === "exec" || /^[A-Za-z_]\w*=/.test(words[0]!))) words.shift();
    const at = words.indexOf("hook");
    if (at > 0 && words[at + 1] !== undefined && isOsnovaLauncher(words.slice(0, at))) return words[at + 1];
  }
  return undefined;
}

// An existing entry is osnova's own when its launch runs `mcp` through an osnova launcher. Only such an entry
// is repointed; the flags after `mcp` are the user's and stay.
function osnovaLaunchTail(launch: readonly unknown[]): string[] | undefined {
  if (!launch.every((part): part is string => typeof part === "string")) return undefined;
  const at = launch.indexOf("mcp");
  return at > 0 && isOsnovaLauncher(launch.slice(0, at)) ? launch.slice(at + 1) : undefined;
}

function entryFor(shape: Shape, command: readonly string[]): unknown {
  if (shape === "opencode") return { type: "local", command: [...command, "mcp"], enabled: true };
  return { command: command[0], args: [...command.slice(1), "mcp"] };
}

function stripJsonc(text: string): string {
  let out = "", i = 0, inString = false;
  while (i < text.length) {
    const ch = text[i]!, next = text[i + 1];
    if (inString) { out += ch; if (ch === "\\") { out += next ?? ""; i += 2; continue; } if (ch === "\"") inString = false; i++; continue; }
    if (ch === "\"") { inString = true; out += ch; i++; continue; }
    if (ch === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (ch === "/" && next === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
    out += ch; i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => [k, sortKeys(v)]));
  return value;
}

function render(value: unknown, indent: string, depth = 0): string {
  const pad = indent.repeat(depth), inner = indent.repeat(depth + 1);
  if (Array.isArray(value) && value.every((item) => item === null || typeof item !== "object")) return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  if (Array.isArray(value)) return `[\n${value.map((item) => `${inner}${render(item, indent, depth + 1)}`).join(",\n")}\n${pad}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${render(item, indent, depth + 1)}`).join(",\n")}\n${pad}}`;
  }
  return JSON.stringify(value);
}

function detectIndent(text: string): string {
  const match = /^( +|\t+)"/m.exec(text);
  return match?.[1] ?? "  ";
}

function mergeJson(existing: string | null, shape: Shape, command: readonly string[]): Merge {
  const rootKey = shape === "opencode" ? "mcp" : "mcpServers";
  const entry = entryFor(shape, command);
  if (existing === null || existing.trim() === "") {
    return { state: "append", merged: `${render({ [rootKey]: { osnova: entry } }, "  ")}\n` };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(stripJsonc(existing)); } catch (error) {
    throw new Error(`osnova setup: cannot parse the existing config as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("osnova setup: the existing config is not a JSON object");
  const root = (parsed as Record<string, unknown>)[rootKey];
  const current = root !== null && typeof root === "object" && !Array.isArray(root) ? (root as Record<string, unknown>).osnova : undefined;
  const indent = detectIndent(existing);
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  if (current !== undefined) {
    if (sameJson(current, entry)) return { state: "unchanged", merged: existing };
    if (current === null || typeof current !== "object" || Array.isArray(current)) return { state: "conflict", merged: existing };
    const record = current as Record<string, unknown>;
    const launch = shape === "opencode" ? record.command : [record.command, ...(Array.isArray(record.args) ? record.args : [])];
    const tail = Array.isArray(launch) ? osnovaLaunchTail(launch) : undefined;
    if (tail === undefined) return { state: "conflict", merged: existing };
    const desired = [...command, "mcp", ...tail];
    if (sameJson(launch, desired)) return { state: "unchanged", merged: existing };
    const next = shape === "opencode" ? { ...record, command: desired } : { ...record, command: desired[0], args: desired.slice(1) };
    const span = locateObject(existing, [rootKey, "osnova"]);
    if (span === null) throw new Error(`osnova setup: cannot locate the ${rootKey}.osnova object in the existing config`);
    return { state: "update", merged: `${existing.slice(0, span.open)}${render(next, indent, 2).replace(/\n/g, eol)}${existing.slice(span.close + 1)}` };
  }
  const entryText = render({ osnova: entry }, indent).split("\n").slice(1, -1).join(eol);
  if (root !== undefined && root !== null && typeof root === "object" && !Array.isArray(root)) {
    const span = locateObject(existing, [rootKey]);
    if (span === null) throw new Error(`osnova setup: cannot locate the ${rootKey} object in the existing config`);
    const position = { lastContentEnd: lastContentBefore(existing, span.close) };
    const empty = Object.keys(root as object).length === 0;
    const inner = entryText.split(eol).map((line) => indent + line).join(eol);
    const head = existing.slice(0, position.lastContentEnd);
    const tail = existing.slice(position.lastContentEnd);
    const closeIndent = indent.repeat(1);
    return { state: "append", merged: empty ? `${head}${eol}${inner}${eol}${closeIndent}${tail.replace(/^\s*/, "")}` : `${head},${eol}${inner}${tail}` };
  }
  const close = existing.lastIndexOf("}");
  if (close < 0) throw new Error("osnova setup: the existing config has no closing brace");
  const bodyEnd = lastContentBefore(existing, close);
  const hasContent = existing.slice(0, bodyEnd).trim().length > 1;
  const block = [`${indent}${JSON.stringify(rootKey)}: {`, ...entryText.split(eol).map((line) => indent + line), `${indent}}`].join(eol);
  const head = existing.slice(0, bodyEnd);
  return { state: "append", merged: `${head}${hasContent ? "," : ""}${eol}${block}${eol}${existing.slice(close)}` };
}

function lastContentBefore(text: string, index: number): number {
  let i = index;
  while (i > 0 && /[\s,]/.test(text[i - 1]!)) i--;
  return i;
}

// The object value at `keys`, walked member by member from the top-level object, as offsets of its braces.
// A key of the same name nested elsewhere (a project's own mcpServers in ~/.claude.json) is never matched.
function locateObject(text: string, keys: readonly string[]): { open: number; close: number } | null {
  const plain = stripJsoncKeepingOffsets(text);
  let open = plain.indexOf("{");
  if (open < 0) return null;
  let close = matchingClose(plain, open);
  for (const key of keys) {
    const member = memberObject(plain, open, close, key);
    if (member === null) return null;
    ({ open, close } = member);
  }
  return { open, close };
}

function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== "\"") i += text[i] === "\\" ? 2 : 1;
  return i;
}

function matchingClose(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\"") { i = stringEnd(text, i); continue; }
    if (ch === "{" || ch === "[") depth++;
    else if ((ch === "}" || ch === "]") && --depth === 0) return i;
  }
  return text.length - 1;
}

function memberObject(text: string, open: number, close: number, key: string): { open: number; close: number } | null {
  let i = open + 1;
  while (i < close) {
    while (i < close && /[\s,]/.test(text[i]!)) i++;
    if (i >= close || text[i] !== "\"") return null;
    const nameEnd = stringEnd(text, i);
    const name = JSON.parse(text.slice(i, nameEnd + 1)) as string;
    i = nameEnd + 1;
    while (i < close && /[\s:]/.test(text[i]!)) i++;
    const valueStart = i;
    if (text[i] === "{" || text[i] === "[") i = matchingClose(text, i) + 1;
    else while (i < close && text[i] !== "," && text[i] !== "}") i = text[i] === "\"" ? stringEnd(text, i) + 1 : i + 1;
    if (name === key && text[valueStart] === "{") return { open: valueStart, close: i - 1 };
  }
  return null;
}

function stripJsoncKeepingOffsets(text: string): string {
  let out = "", i = 0, inString = false;
  while (i < text.length) {
    const ch = text[i]!, next = text[i + 1];
    if (inString) { out += ch; if (ch === "\\") { out += next ?? ""; i += 2; continue; } if (ch === "\"") inString = false; i++; continue; }
    if (ch === "\"") { inString = true; out += ch; i++; continue; }
    if (ch === "/" && next === "/") { while (i < text.length && text[i] !== "\n") { out += " "; i++; } continue; }
    if (ch === "/" && next === "*") { while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) { out += text[i] === "\n" ? "\n" : " "; i++; } out += "  "; i += 2; continue; }
    out += ch; i++;
  }
  return out;
}

function mergeToml(existing: string | null, command: readonly string[]): Merge {
  const block = `[mcp_servers.osnova]\ncommand = ${JSON.stringify(command[0])}\nargs = ${JSON.stringify([...command.slice(1), "mcp"])}\n`;
  if (existing === null || existing.trim() === "") return { state: "append", merged: block };
  const table = /^\s*\[mcp_servers\.osnova\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(existing);
  if (table !== null) {
    const repointed = repointToml(existing, table.index + table[0].length - table[1]!.length, table[1]!, command);
    if (repointed !== undefined) return repointed;
    const body = table[1]!.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#")).sort();
    const want = block.split("\n").slice(1).map((line) => line.trim()).filter((line) => line.length > 0).sort();
    return { state: JSON.stringify(body) === JSON.stringify(want) ? "unchanged" : "conflict", merged: existing };
  }
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const base = existing.endsWith(eol) ? existing : existing + eol;
  return { state: "append", merged: `${base}${eol}${block.replace(/\n/g, eol)}` };
}

// The table's `command` and `args` lines, when both are plain double-quoted values, rewritten for this install;
// every other key and the `[mcp_servers.osnova.tools.*]` tables that follow stay as written.
function repointToml(existing: string, bodyStart: number, body: string, command: readonly string[]): Merge | undefined {
  const commandLine = /^[ \t]*command[ \t]*=[ \t]*(".*")[ \t]*$/m.exec(body), argsLine = /^[ \t]*args[ \t]*=[ \t]*(\[.*\])[ \t]*$/m.exec(body);
  if (commandLine === null || argsLine === null) return undefined;
  let launch: unknown[];
  try { launch = [JSON.parse(commandLine[1]!), ...(JSON.parse(argsLine[1]!) as unknown[])]; } catch { return undefined; }
  const tail = osnovaLaunchTail(launch);
  if (tail === undefined) return undefined;
  const desired = [...command, "mcp", ...tail];
  if (sameJson(launch, desired)) return { state: "unchanged", merged: existing };
  const next = body
    .replace(commandLine[0], commandLine[0].replace(commandLine[1]!, JSON.stringify(desired[0])))
    .replace(argsLine[0], argsLine[0].replace(argsLine[1]!, JSON.stringify(desired.slice(1)).replace(/","/g, "\", \"")));
  return { state: "update", merged: `${existing.slice(0, bodyStart)}${next}${existing.slice(bodyStart + body.length)}` };
}

export function unifiedDiff(file: string, before: string, after: string, context = 3): string {
  const a = before === "" ? [] : before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  if (a.length > 0 && a.at(-1) === "") a.pop();
  if (b.length > 0 && b.at(-1) === "") b.pop();
  const n = a.length, m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const ops: { kind: " " | "-" | "+"; text: string; ai: number; bj: number }[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ kind: " ", text: a[i]!, ai: i, bj: j }); i++; j++; }
    else if (i < n && (j >= m || table[i + 1]![j]! >= table[i]![j + 1]!)) { ops.push({ kind: "-", text: a[i]!, ai: i, bj: j }); i++; }
    else { ops.push({ kind: "+", text: b[j]!, ai: i, bj: j }); j++; }
  }
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => { if (op.kind !== " ") for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) keep[k] = true; });
  const lines = [`--- ${before === "" ? "/dev/null" : file}`, `+++ ${file}`];
  let index = 0;
  while (index < ops.length) {
    if (!keep[index]) { index++; continue; }
    let end = index;
    while (end < ops.length && keep[end]) end++;
    const slice = ops.slice(index, end);
    const aCount = slice.filter((op) => op.kind !== "+").length, bCount = slice.filter((op) => op.kind !== "-").length;
    const aStart = aCount === 0 ? slice[0]!.ai : slice[0]!.ai + 1, bStart = bCount === 0 ? slice[0]!.bj : slice[0]!.bj + 1;
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`, ...slice.map((op) => `${op.kind}${op.text}`));
    index = end;
  }
  return lines.join("\n") + "\n";
}

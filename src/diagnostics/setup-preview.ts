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

interface Merge { readonly state: "append" | "update" | "unchanged" | "conflict"; readonly merged: string; }

// An existing entry is osnova's own when its launch runs `mcp` and a part before it names osnova (a path to
// another install, `npx @getdomovoi/osnova`, a bare `osnova`). Only such an entry is repointed; the flags after
// `mcp` are the user's and stay.
function osnovaLaunchTail(launch: readonly unknown[]): string[] | undefined {
  if (!launch.every((part): part is string => typeof part === "string")) return undefined;
  const at = launch.indexOf("mcp");
  return at > 0 && launch.slice(0, at).some((part) => /osnova/.test(part)) ? launch.slice(at + 1) : undefined;
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

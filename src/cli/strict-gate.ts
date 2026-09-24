import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadIndex, refreshWorkspace, indexGeneration } from "../api.js";
import { resolveCacheDir } from "../cache/cache.js";
import { maximumIndexedFileSizeBytes } from "../types.js";
import { parseSearchCall, shellPipelines, shellWords } from "./search-guard.js";

export const gateClients = ["claude-code", "codex", "cursor", "opencode", "kilo", "pi"] as const;
export type GateClient = (typeof gateClients)[number];
export interface GateInput {
  readonly cwd?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly toolUseId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly toolInput?: Readonly<Record<string, unknown>> | undefined;
  readonly toolResponse?: unknown;
}

const queryName = /(?:^|__|_|:)osnova_(?:ground|thread|outline|warp|groundwork|footing|settle|plumb|tests|unreferenced)$/;
export function isOsnovaQuery(name?: string): boolean { return queryName.test(name ?? ""); }
const discoveryTools = new Set(["grep", "glob", "find", "search", "rg", "ripgrep", "codebase_search", "file_search", "list", "list_directory"]);
const readTools = new Set(["read", "read_file", "readfile", "read_text_file"]);
const shellTools = new Set(["bash", "shell", "shell_command", "exec_command", "execute_command", "run_terminal_cmd"]);
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

export function gatePayload(client: GateClient, reason: string): unknown {
  if (client === "cursor") return { permission: "deny", user_message: "Osnova exploration required", agent_message: reason };
  if (client === "pi") return { block: true, reason };
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function receiptRoot(workspace: string, session: string, cacheDir?: string, agent = ""): string {
  return path.join(resolveCacheDir(cacheDir), "strict-hooks", digest(JSON.stringify([workspace, session, agent])));
}

async function epoch(root: string): Promise<string> {
  try {
    const value = await fs.readFile(path.join(root, "turn"), "utf8");
    if (!/^[\w-]+$/.test(value)) throw new Error("invalid osnova hook turn state");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "initial";
    throw error;
  }
}

export async function resetGate(input: GateInput, workspace: string, cacheDir?: string): Promise<void> {
  if (input.sessionId === undefined) return;
  const root = receiptRoot(await fs.realpath(workspace), input.sessionId, cacheDir, input.agentId);
  const previous = await epoch(root);
  await fs.mkdir(root, { recursive: true });
  const temporary = path.join(root, `turn-${randomUUID()}`);
  await fs.writeFile(temporary, randomUUID());
  await fs.rename(temporary, path.join(root, "turn"));
  await fs.rm(path.join(root, previous), { recursive: true, force: true });
}

function responseText(value: unknown): string | null {
  if (typeof value === "string") {
    try { return responseText(JSON.parse(value)); } catch { return value; }
  }
  if (Array.isArray(value)) {
    const texts = value.map(responseText);
    return texts.includes(null) ? null : texts.join("\n");
  }
  if (value === null || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (record.isError === true || record.is_error === true || record.error !== undefined) return null;
  return responseText(record.content ?? record.text ?? record.output ?? record.result ?? "");
}

async function matchesSource(file: string, hash: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(hash)) return false;
  try {
    const before = await fs.lstat(file, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maximumIndexedFileSizeBytes)) return false;
    const content = await fs.readFile(file);
    const after = await fs.lstat(file, { bigint: true });
    return after.isFile() && before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
      before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs &&
      createHash("sha256").update(content).digest("hex") === hash;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

export async function markGate(input: GateInput, workspace: string, cacheDir?: string): Promise<void> {
  if (input.sessionId === undefined || !isOsnovaQuery(input.toolName)) return;
  const text = responseText(input.toolResponse);
  if (text === null || text.length === 0) return;
  const canonicalWorkspace = await fs.realpath(workspace);
  const root = receiptRoot(canonicalWorkspace, input.sessionId, cacheDir, input.agentId);
  const turn = await epoch(root);
  if (input.toolUseId !== undefined) {
    const pending = path.join(root, turn, "queries", digest(input.toolUseId));
    const started = await fs.readFile(pending, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    if (started !== digest(input.toolName!)) return;
  }
  const index = await loadIndex(canonicalWorkspace, { cacheDir });
  if (index === undefined || !new RegExp(`^osnova generation ${indexGeneration(index).slice(0, 16)}$`, "m").test(text)) return;
  const directory = path.join(root, turn, digest(input.turnId ?? ""));
  const scope = input.toolInput?.file ?? input.toolInput?.in;
  const scopedFile = typeof scope === "string" ? path.relative(index.root, path.resolve(index.root, scope)).split(path.sep).join("/") : undefined;
  for (const [file, card] of index.files) {
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (file !== scopedFile && !new RegExp(`(?:^|[\\s(])${escaped}(?::\\d|#)|^- ${escaped}\\r?$`, "m").test(text)) continue;
    if (!await matchesSource(path.join(index.root, file), card.hash)) continue;
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, digest(file)), card.hash);
  }
}

function pathsOf(args: Readonly<Record<string, unknown>>): string[] {
  return ["file_path", "filePath", "path", "paths", "search_paths", "directory", "dir"].flatMap((key) => {
    const value = args[key];
    return typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  });
}

export interface GateSubject { readonly targets: readonly string[]; readonly cwd: string }
const exploration = /(?:^|[\s;|&(/])(?:rg|grep|egrep|fgrep|ag|ack|fd|find|cat|head|tail|sed|awk|nl|ls|tree|Get-Content|Select-String|Get-ChildItem)(?:\s|$)|\bgit\s+(?:grep|ls-files)\b/i;

function outputFilter(words: readonly string[]): boolean {
  const [name, ...args] = words;
  if (name === "head" || name === "tail") return args.length === 0 || args.length === 1 && /^-\d+$/.test(args[0]!) || args.length === 2 && /^-[nc]$/.test(args[0]!) && /^\d+$/.test(args[1]!);
  if (name !== "grep" && name !== "rg") return false;
  let i = 0;
  while (/^-[ivnEcq]+$/.test(args[i] ?? "")) i += 1;
  if (args[i] === "--") i += 1;
  return i === args.length - 1 && !args[i]!.startsWith("-");
}

function pipelineTargets(command: string, cwd: string): readonly string[] | null {
  const parsed = shellPipelines(command);
  if (parsed === null) return null;
  const targets: string[] = [];
  let directory = cwd;
  for (const pipeline of parsed) {
    for (const [i, words] of pipeline.entries()) {
      if (words[0] === "cd") {
        if (pipeline.length !== 1 || words.length !== 2 || words[1]!.startsWith("-") || /[~*?[\]]/.test(words[1]!)) return null;
        directory = path.resolve(directory, words[1]!);
        continue;
      }
      if (i > 0 && outputFilter(words)) continue;
      const literal = words.map((word) => `'${word.replace(/'/g, "'\\''")}'`).join(" ");
      const read = readPaths(literal);
      const search = parseSearchCall("Bash", { command: literal });
      if (read !== null) targets.push(...read.map((file) => path.resolve(directory, file)));
      else if (search !== null) targets.push(...(search.paths.length > 0 ? search.paths : ["."]).map((file) => path.resolve(directory, file)));
      else if (exploration.test(words.join(" "))) return null;
    }
  }
  return targets;
}

function readPaths(command: string): readonly string[] | null {
  const words = shellWords(command);
  if (words === null || words[0] === undefined) return null;
  const name = path.basename(words[0]);
  if (name === "sed") return words[1] === "-n" && /^\d+(?:,\d+)?p$/.test(words[2] ?? "") && words.length > 3 && words.slice(3).every((word) => !word.startsWith("-")) ? words.slice(3) : null;
  if (name !== "cat" && name !== "head" && name !== "tail" && name !== "nl" && name !== "ls") return null;
  const paths: string[] = [];
  let flags = true;
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i]!;
    if (flags && word === "--") { flags = false; continue; }
    if (!flags || !word.startsWith("-") || word === "-") { paths.push(word); continue; }
    if ((name === "head" || name === "tail") && (word === "-n" || word === "-c")) {
      if (!/^[+-]?\d+$/.test(words[++i] ?? "")) return null;
    } else if (name === "ls" ? !/^-[1aAbBcCdFfghHiklLmnopqQrRsStuUvx]+$/.test(word) : name === "cat" ? !/^-[AbEenstTv]+$/.test(word) : name === "nl" ? word !== "-ba" : !/^-(?:[nc]?[+-]?\d+|[qv])$/.test(word)) return null;
  }
  if (name === "ls" && paths.length === 0) return ["."];
  return paths.length > 0 && !paths.includes("-") ? paths : null;
}

export function strictSubject(input: GateInput, workspace: string): GateSubject | null {
  const name = (input.toolName ?? "").split("__").at(-1)!.toLowerCase();
  if (isOsnovaQuery(input.toolName)) return null;
  const args = input.toolInput ?? {};
  const cwd = path.resolve(input.cwd ?? workspace, typeof args.workdir === "string" ? args.workdir : typeof args.cwd === "string" ? args.cwd : typeof args.working_directory === "string" ? args.working_directory : ".");
  if (discoveryTools.has(name) || readTools.has(name)) {
    const targets = pathsOf(args);
    if ((name === "glob" || name === "find") && typeof args.pattern === "string" && (path.isAbsolute(args.pattern) || args.pattern.split(/[\\/]/).includes(".."))) targets.push(path.resolve(cwd, targets[0] ?? ".", args.pattern));
    return { targets: targets.length > 0 ? targets : ["."], cwd };
  }
  if (!shellTools.has(name)) return null;
  const raw = args.command ?? args.cmd;
  const command = typeof raw === "string" ? raw : Array.isArray(raw) && raw.every((v) => typeof v === "string") ? raw.join(" ") : "";
  const search = parseSearchCall("Bash", { command });
  if (search !== null && !/[|;&<>\n]/.test(command)) return { targets: search.paths.length > 0 ? search.paths : ["."], cwd: path.resolve(cwd, search.base) };
  // A simple file read can use a receipt. Compound or dynamic exploration must be split into scoped calls.
  const read = readPaths(command);
  if (read !== null) return { targets: read, cwd };
  if (!exploration.test(command)) return null;
  const targets = pipelineTargets(command, cwd);
  if (targets !== null) return targets.length === 0 ? null : { targets, cwd };
  return { targets: ["."], cwd };
}

async function canonicalTarget(target: string): Promise<string> {
  let parent = target;
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(parent), ...suffix); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
      const next = path.dirname(parent);
      if (next === parent) return target;
      suffix.unshift(path.basename(parent));
      parent = next;
    }
  }
}

export async function strictGate(input: GateInput, workspace: string, cacheDir?: string): Promise<string | null> {
  if (isOsnovaQuery(input.toolName)) {
    if (input.sessionId !== undefined && input.toolUseId !== undefined) {
      const root = receiptRoot(await fs.realpath(workspace), input.sessionId, cacheDir, input.agentId);
      const directory = path.join(root, await epoch(root), "queries");
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, digest(input.toolUseId)), digest(input.toolName!));
    }
    return null;
  }
  const subject = strictSubject(input, workspace);
  if (subject === null || workspace === os.homedir() || workspace === path.parse(workspace).root) return null;
  const canonicalWorkspace = await fs.realpath(workspace);
  const targets: string[] = [];
  for (const target of subject.targets) {
    const absolute = path.resolve(subject.cwd, target.startsWith("~") ? path.join(os.homedir(), target.slice(1)) : target);
    const canonical = await canonicalTarget(absolute);
    const relative = path.relative(canonicalWorkspace, canonical);
    const parent = path.relative(canonical, canonicalWorkspace);
    const containsWorkspace = parent === "" || parent !== ".." && !parent.startsWith(`..${path.sep}`) && !path.isAbsolute(parent);
    if (!containsWorkspace && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) continue;
    targets.push(canonical);
  }
  if (targets.length === 0) return null;
  const receiptDirectory = input.sessionId === undefined ? undefined : receiptRoot(canonicalWorkspace, input.sessionId, cacheDir, input.agentId);
  const receiptTurn = receiptDirectory === undefined ? undefined : await epoch(receiptDirectory);
  if (receiptDirectory !== undefined && receiptTurn !== undefined) {
    for (let i = targets.length - 1; i >= 0; i -= 1) {
      const canonical = targets[i]!;
      const relative = path.relative(canonicalWorkspace, canonical).split(path.sep).join("/");
      const receipt = await fs.readFile(path.join(receiptDirectory, receiptTurn, digest(input.turnId ?? ""), digest(relative)), "utf8").catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      });
      if (await matchesSource(canonical, receipt)) targets.splice(i, 1);
    }
    if (await epoch(receiptDirectory) !== receiptTurn) return "osnova gate: prompt changed; use osnova_footing again.";
    if (targets.length === 0) return null;
  }
  const index = await refreshWorkspace(workspace, { cacheDir });
  for (const canonical of targets) {
    const fromTarget = path.relative(canonical, index.root);
    const containsWorkspace = fromTarget === "" || fromTarget !== ".." && !fromTarget.startsWith(`..${path.sep}`) && !path.isAbsolute(fromTarget);
    const relative = containsWorkspace ? "" : path.relative(index.root, canonical).split(path.sep).join("/");
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) continue;
    const file = index.files.get(relative);
    if (file?.language === "fallback") continue;
    const covered = file !== undefined || [...index.files].some(([name, card]) => card.language !== "fallback" && (relative === "" || name.startsWith(`${relative}/`)));
    if (!covered && !/[*?[\]$`]/.test(canonical)) continue;
    return file !== undefined
      ? "osnova gate: indexed file has no current grant. Query this file with osnova_outline or find it with osnova_ground/footing; await the result, then read/search named files. Edits/new prompts require fresh evidence."
      : "osnova gate: repository discovery or unscoped source command blocked. Use osnova_ground/footing/thread, then read named files. Queries never grant directory listings; do not retry discovery through another tool/interpreter. Operational commands and unindexed paths allowed; split mixed commands.";
  }
  return null;
}

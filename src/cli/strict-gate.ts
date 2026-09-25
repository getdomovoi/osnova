import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadIndex, refreshWorkspace, indexGeneration } from "../api.js";
import { resolveCacheDir } from "../cache/cache.js";
import { maximumIndexedFileSizeBytes } from "../types.js";
import { languageForPath } from "../grammar/languages.js";
import { parseSearchCall, shellPipelines, shellPipelinesWithGlobs, shellWords } from "./search-guard.js";

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
const discoveryTools = new Set(["grep", "glob", "find", "search", "rg", "ripgrep", "codebase_search", "file_search", "list", "list_directory", "list_dir", "ls", "grep_search", "grep_grep_search"]);
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
  if (input.toolName?.endsWith("osnova_plumb")) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "query"), indexGeneration(index));
    return;
  }
  const scope = input.toolInput?.file ?? input.toolInput?.in;
  const scopedFile = typeof scope === "string" ? path.relative(index.root, path.resolve(index.root, scope)).split(path.sep).join("/") : undefined;
  let granted = false;
  for (const [file, card] of index.files) {
    if (file !== scopedFile) {
      if (!text.includes(file)) continue;
      const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`(?:^|[\\s(])${escaped}(?::\\d|#)|^- ${escaped}\\r?$`, "m").test(text)) continue;
    }
    if (!await matchesSource(path.join(index.root, file), card.hash)) continue;
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, digest(file)), card.hash);
    granted = true;
  }
  if (granted) await fs.writeFile(path.join(directory, "query"), indexGeneration(index));
}

function pathsOf(args: Readonly<Record<string, unknown>>): string[] {
  return ["file_path", "filePath", "path", "paths", "search_paths", "directory", "dir", "dir_path"].flatMap((key) => {
    const value = args[key];
    return typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  });
}

export interface GateSubject { readonly targets: readonly string[]; readonly cwd: string; readonly opaque?: true }
const exploration = /^\s*(?:rg|grep|egrep|fgrep|ag|ack|fd|find|cat|head|tail|sed|awk|nl|ls|tree|Get-Content|Select-String|Get-ChildItem)(?:\s|$)|^\s*git\s+(?:grep|ls-files|show|ls-tree)\b/i;
const explorationCommands = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack", "fd", "find", "cat", "head", "tail", "sed", "awk", "nl", "ls", "tree", "Get-Content", "Select-String", "Get-ChildItem"]);
const indexedFileDenial = "osnova gate: indexed file has no current grant. Query this file with osnova_outline or find it with osnova_ground/footing; await the result, then read/search named files. Edits/new prompts require fresh evidence.";
const directoryDenial = "osnova gate: repository discovery or unscoped source command blocked. Use osnova_ground/footing/thread, then read named files. Queries never grant directory listings; do not retry discovery through another tool/interpreter. Passive operations and unindexed paths remain available; scripts need a successful query. Split mixed commands.";

function outputFilter(words: readonly string[]): boolean {
  const [name, ...args] = words;
  if (name === "head" || name === "tail") return args.length === 0 || args.length === 1 && /^-\d+$/.test(args[0]!) || args.length === 2 && /^-[nc]$/.test(args[0]!) && /^\d+$/.test(args[1]!);
  if (name === "sed") return args.length === 2 && args[0] === "-n" && /^\d+(?:,\d+)?p$/.test(args[1]!);
  if (name === "cat") return args.length === 0 || args.length === 1 && ["-n", "-b"].includes(args[0]!);
  if (name !== "grep" && name !== "rg") return false;
  let i = 0;
  while (/^-[ivnEcq]+$/.test(args[i] ?? "")) i += 1;
  if (args[i] === "--") i += 1;
  return i === args.length - 1 && !args[i]!.startsWith("-");
}

function shellPath(directory: string, target: string): string {
  return path.resolve(directory, target === "~" || target.startsWith("~/") ? path.join(os.homedir(), target.slice(1)) : target);
}

function pipelineTargets(command: string, cwd: string): { targets: readonly string[]; opaque: boolean } | null {
  const parsed = shellPipelinesWithGlobs(command);
  if (parsed === null) return null;
  const targets: string[] = [];
  let opaque = false;
  let directory = cwd;
  for (const pipeline of parsed) {
    for (const [i, tokens] of pipeline.entries()) {
      const words = tokens.map((word) => word.text);
      const name = path.basename(words[0] ?? "");
      if (words[0] === "cd") {
        if (pipeline.length !== 1 || words.length !== 2 || words[1]!.startsWith("-") || /[~*?[\]]/.test(words[1]!)) return null;
        directory = path.resolve(directory, words[1]!);
        continue;
      }
      if (i > 0 && outputFilter(words)) continue;
      if (name === "git" && ["show", "ls-tree"].includes(words[1] ?? "") || name === "echo" && tokens.slice(1).some((word) => word.glob)) {
        targets.push(directory);
        continue;
      }
      if (name === "cat" && words.length === 1) { opaque = true; continue; }
      const literal = words.map((word) => `'${word.replace(/'/g, "'\\''")}'`).join(" ");
      const read = readPaths(literal);
      const search = parseSearchCall("Bash", { command: literal });
      if (read !== null) targets.push(...read.map((file) => shellPath(directory, file)));
      else if (search !== null) targets.push(...(search.paths.length > 0 ? search.paths : ["."]).map((file) => shellPath(directory, file)));
      else if (passiveOperation(literal)) continue;
      else if (explorationCommands.has(name) || name === "git" && ["grep", "ls-files"].includes(words[1] ?? "")) return null;
      else opaque = true;
    }
  }
  return { targets, opaque };
}

function readPaths(command: string): readonly string[] | null {
  const words = shellWords(command);
  if (words === null || words[0] === undefined) return null;
  const name = path.basename(words[0]);
  if (name === "sed") return words[1] === "-n" && /^\d+(?:,\d+)?p$/.test(words[2] ?? "") && words.length > 3 && words.slice(3).every((word) => !word.startsWith("-")) ? words.slice(3) : null;
  if (name !== "cat" && name !== "head" && name !== "tail" && name !== "nl" && name !== "ls" && name !== "tac" && name !== "bat") return null;
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

function passiveOperation(command: string): boolean {
  const parsed = shellPipelines(command);
  return parsed !== null && parsed.length > 0 && parsed.every((pipeline) => pipeline.every((words, position) => {
    const [name, first, second] = words;
    if (name === "cd") return pipeline.length === 1 && words.length === 2 && !first!.startsWith("-") && !/[~*?[\]$`]/.test(first!);
    if (position > 0 && outputFilter(words)) return true;
    if (name === "git") {
      const args = words.slice(2);
      if (first === "status") return args.every((arg) => ["--short", "-s", "--porcelain", "--porcelain=v1", "--branch", "-b"].includes(arg));
      if (first === "branch") return args.every((arg) => ["--show-current", "--list", "-a", "-r"].includes(arg));
      if (first === "log") return args.every((arg) => ["--oneline", "--decorate", "--all"].includes(arg) || /^-\d+$/.test(arg));
      return first === "rev-parse" || first === "merge-base";
    }
    return name === "gh" && first === "pr" && ["checks", "view", "status"].includes(second ?? "");
  }));
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
  if (passiveOperation(command)) return null;
  const parsed = pipelineTargets(command, cwd);
  if (parsed !== null) return parsed.targets.length === 0 && !parsed.opaque ? null : { targets: parsed.targets, cwd, ...(parsed.opaque ? { opaque: true as const } : {}) };
  return exploration.test(command) ? { targets: ["."], cwd } : { targets: [], cwd, opaque: true };
}

async function gateState(input: GateInput, workspace: string, cacheDir?: string): Promise<string | undefined> {
  if (input.sessionId === undefined) return undefined;
  const root = receiptRoot(workspace, input.sessionId, cacheDir, input.agentId);
  return path.join(root, await epoch(root), digest(input.turnId ?? ""));
}

async function recordDenial(state: string | undefined, workspace: string, target: string): Promise<void> {
  if (state === undefined) return;
  const relative = path.relative(workspace, target).split(path.sep).join("/") || ".";
  const directory = path.join(state, "denied");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, digest(relative)), relative);
}

async function unresolvedDenial(state: string, workspace: string, cacheDir?: string): Promise<boolean> {
  const directory = path.join(state, "denied");
  const names = await fs.readdir(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  let index: Awaited<ReturnType<typeof loadIndex>> = undefined;
  for (const name of names) {
    const relative = await fs.readFile(path.join(directory, name), "utf8");
    if (relative === "." || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return true;
    const receipt = await fs.readFile(path.join(state, digest(relative)), "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    if (await matchesSource(path.join(workspace, relative), receipt)) continue;
    index ??= await loadIndex(workspace, { cacheDir });
    const file = index?.files.get(relative);
    if (index !== undefined && (file === undefined || file.language === "fallback")) continue;
    return true;
  }
  return false;
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

async function sourceDenial(input: GateInput, workspace: string, canonicalWorkspace: string, subject: GateSubject, cacheDir?: string): Promise<string | null> {
  const targets: string[] = [];
  for (const target of subject.targets) {
    const absolute = shellPath(subject.cwd, target);
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
  for (let i = targets.length - 1; i >= 0; i -= 1) {
    const canonical = targets[i]!;
    if (languageForPath(path.relative(canonicalWorkspace, canonical)) !== undefined) continue;
    const stat = await fs.lstat(canonical).catch((error: unknown) => {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
      throw error;
    });
    if (stat?.isFile()) targets.splice(i, 1);
  }
  if (targets.length === 0) return null;
  const cached = await loadIndex(canonicalWorkspace, { cacheDir });
  if (cached === undefined) {
    for (const canonical of targets) {
      const relative = path.relative(canonicalWorkspace, canonical);
      if (languageForPath(relative) !== undefined) {
        await recordDenial(await gateState(input, canonicalWorkspace, cacheDir), canonicalWorkspace, canonical);
        return "osnova gate: source file has no current grant. Use osnova_footing or osnova_outline to build the index and name the file before reading it.";
      }
      const stat = await fs.lstat(canonical).catch((error: unknown) => {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
        throw error;
      });
      if (stat?.isDirectory() || /[*?[\]$`]/.test(canonical)) return directoryDenial;
    }
    return null;
  }
  for (const canonical of targets) {
    const relative = path.relative(cached.root, canonical).split(path.sep).join("/");
    const file = cached.files.get(relative);
    if (file !== undefined && file.language !== "fallback") {
      await recordDenial(await gateState(input, canonicalWorkspace, cacheDir), canonicalWorkspace, canonical);
      return indexedFileDenial;
    }
    if ([...cached.files].some(([name, card]) => card.language !== "fallback" && (relative === "" || name.startsWith(`${relative}/`)))) return directoryDenial;
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
    if (file !== undefined) await recordDenial(await gateState(input, canonicalWorkspace, cacheDir), canonicalWorkspace, canonical);
    return file !== undefined ? indexedFileDenial : directoryDenial;
  }
  return null;
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
  const denied = await sourceDenial(input, workspace, canonicalWorkspace, subject, cacheDir);
  if (denied !== null || !subject.opaque) return denied;
  if (subject.opaque) {
    const state = await gateState(input, canonicalWorkspace, cacheDir);
    const query = state === undefined ? "" : await fs.readFile(path.join(state, "query"), "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    if (!/^[a-f0-9]{64}$/.test(query)) return "osnova gate: executable command needs a completed Osnova query in this prompt; await its result before running scripts or operations.";
    if (await unresolvedDenial(state!, canonicalWorkspace, cacheDir)) return "osnova gate: earlier source denial remains unresolved; query the denied file before running an opaque command. Directory discovery cannot be granted by a file query.";
    return null;
  }
  return null;
}

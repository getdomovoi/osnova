import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isOsnovaLauncher, isOsnovaProgram, previewRemoval, previewSetup, unifiedDiff } from "./setup-preview.js";
import type { SetupClientId } from "./setup-preview.js";
import { hookSettingsObject, isHookEvent } from "../cli/hook.js";
import type { HookClient } from "../cli/hook.js";

// Applying a setup: every file change is planned first (path, action, diff), then written with a
// timestamped backup of whatever was there. A conflict is never resolved by writing.
export interface PlannedChange {
  readonly kind: "mcp" | "hooks" | "instructions" | "plugin" | "skill";
  /** A skill or plugin whose file or folder is a link; setup never writes through it. */
  readonly linked?: boolean | undefined;
  readonly path: string;
  /** remove edits osnova's part out of a file; delete removes a file osnova installed (and its folder once empty). */
  readonly action: "create" | "append" | "update" | "remove" | "delete" | "unchanged" | "conflict";
  readonly diff: string;
  readonly merged: string;
  readonly notice: string;
}

export interface AppliedChange extends PlannedChange {
  readonly written: boolean;
  readonly backup?: string | undefined;
}

const instructionsStart = "<!-- osnova:start -->";
const instructionsEnd = "<!-- osnova:end -->";


export async function planMcp(client: SetupClientId, options: { home?: string | undefined; configPath?: string | undefined; command?: readonly string[] | undefined }): Promise<PlannedChange> {
  const preview = await previewSetup(client, options);
  return { kind: "mcp", path: preview.path, action: preview.action, diff: preview.diff, merged: preview.merged, notice: preview.notice };
}

// Hook files: Claude Code (~/.claude/settings.json) and Codex (~/.codex/hooks.json) share the event-group shape;
// Cursor (~/.cursor/hooks.json) lists commands per event under a version key. Existing osnova hook commands
// (a command naming osnova that runs `hook <name>`) are reconciled with this install: the part before
// `hook <name>` is repointed at this command, keeping the entry's own flags, timeout and matcher; an osnova
// hook this build cannot run, a duplicate, or a proposed hook filed under another event is removed; a
// proposed hook still missing is added. Hooks that are not osnova's are never touched, even inside a
// group osnova shares, and every other key survives with the file's indent.
export async function planHooks(options: { home?: string | undefined; settingsPath?: string | undefined; command?: readonly string[] | undefined; client?: HookClient | undefined; nudge?: boolean | undefined }): Promise<PlannedChange> {
  const client = options.client ?? "claude-code";
  const home = path.resolve(options.home ?? os.homedir());
  const defaultPath = client === "codex" ? path.join(home, ".codex", "hooks.json") : client === "cursor" ? path.join(home, ".cursor", "hooks.json") : path.join(home, ".claude", "settings.json");
  const target = options.settingsPath === undefined ? defaultPath : path.resolve(options.settingsPath);
  const existing = await readOptional(target);
  let root: Record<string, unknown> = {};
  if (existing !== null && existing.trim().length > 0) {
    let parsed: unknown;
    try { parsed = JSON.parse(existing); } catch (error) { throw new Error(`osnova setup: cannot parse ${target} as JSON: ${error instanceof Error ? error.message : String(error)}`); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`osnova setup: ${target} is not a JSON object`);
    root = parsed as Record<string, unknown>;
  }
  const wanted = hookSettingsObject(options.command ?? ["osnova"], client, options.nudge === true);
  const wantedHooks = wanted.hooks as Record<string, unknown[]>;
  const hooks = (root.hooks !== null && typeof root.hooks === "object" && !Array.isArray(root.hooks) ? { ...(root.hooks as Record<string, unknown>) } : {});
  const commandOf = (item: unknown): string[] => {
    if (item === null || typeof item !== "object") return [];
    const record = item as { command?: unknown; hooks?: unknown };
    if (typeof record.command === "string") return [record.command];
    return Array.isArray(record.hooks) ? record.hooks.flatMap(commandOf) : [];
  };
  const wantedEvent = new Map<string, string>();
  for (const [event, entries] of Object.entries(wantedHooks)) for (const entry of entries) {
    const name = splitHook(commandOf(entry)[0] ?? "")?.name;
    if (name !== undefined) wantedEvent.set(name, event);
  }
  const prefix = splitHook(commandOf(Object.values(wantedHooks)[0]?.[0])[0] ?? "")?.prefix ?? "osnova";
  const kept = new Set<string>(), unknown = new Set<string>(), duplicates = new Set<string>(), moved = new Set<string>();
  let repointed = 0;
  // Returns the entry to keep, rewritten when its prefix changes, or undefined to drop it.
  const reconcile = (event: string, item: unknown): unknown => {
    const command = item !== null && typeof item === "object" ? (item as { command?: unknown }).command : undefined;
    const hook = typeof command === "string" ? splitHook(command) : undefined;
    const parts = hook === undefined ? [] : hook.prefix.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    if (hook === undefined) return item;
    // A shell-wrapped command cannot be rewritten safely: it still counts as present, but is never changed.
    if (!plainCommand(hook)) { if (isOsnovaProgram(parts.at(-1) ?? "") && isHookEvent(hook.name)) kept.add(hook.name); return item; }
    if (!isOsnovaLauncher(parts)) return item;
    if (!isHookEvent(hook.name)) { unknown.add(hook.name); return undefined; }
    const proposed = wantedEvent.get(hook.name);
    if (proposed !== undefined && proposed !== event) { moved.add(hook.name); return undefined; }
    if (kept.has(hook.name)) { duplicates.add(hook.name); return undefined; }
    kept.add(hook.name);
    const next = `${prefix} hook ${hook.name}${hook.tail}`;
    if (next === command) return item;
    repointed += 1;
    return { ...(item as Record<string, unknown>), command: next };
  };
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const groups: unknown[] = [];
    for (const group of value) {
      const inner = group !== null && typeof group === "object" ? (group as { hooks?: unknown }).hooks : undefined;
      if (!Array.isArray(inner)) { const item = reconcile(event, group); if (item !== undefined) groups.push(item); continue; }
      const items = inner.map((item) => reconcile(event, item)).filter((item) => item !== undefined);
      if (items.length === 0 && inner.length > 0) continue;
      groups.push(items.length === inner.length && items.every((item, index) => item === inner[index]) ? group : { ...(group as Record<string, unknown>), hooks: items });
    }
    if (groups.length === 0 && value.length > 0) delete hooks[event];
    else hooks[event] = groups;
  }
  let added = 0;
  for (const [event, entries] of Object.entries(wantedHooks)) for (const entry of entries) {
    const name = splitHook(commandOf(entry)[0] ?? "")?.name;
    if (name !== undefined && kept.has(name)) continue;
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] as unknown[] : []), entry];
    added += 1;
  }
  const removed = unknown.size + duplicates.size + moved.size;
  if (added === 0 && repointed === 0 && removed === 0) return { kind: "hooks", path: target, action: "unchanged", diff: "", merged: existing ?? "", notice: `${target} already runs every osnova hook for ${client} from ${prefix}.` };
  const indent = existing === null ? "  " : (/^( +|\t+)"/m.exec(existing)?.[1] ?? "  ");
  const merged = withEol(`${JSON.stringify({ ...(client === "cursor" && root.version === undefined ? { version: 1 } : {}), ...root, hooks }, null, indent)}\n`, existing);
  const action = existing === null ? "create" : repointed === 0 && removed === 0 ? "append" : "update";
  const names = (set: ReadonlySet<string>): string => [...set].sort().join(", ");
  const parts = [
    added > 0 ? `${added} osnova hook entr${added === 1 ? "y" : "ies"} added` : "",
    repointed > 0 ? `${repointed} repointed at ${prefix}` : "",
    unknown.size > 0 ? `removed hooks this osnova cannot run: ${names(unknown)}` : "",
    duplicates.size > 0 ? `removed duplicates: ${names(duplicates)}` : "",
    moved.size > 0 ? `moved to their proposed event: ${names(moved)}` : "",
  ].filter((part) => part.length > 0);
  return { kind: "hooks", path: target, action, diff: unifiedDiff(target, existing ?? "", merged), merged, notice: `${parts.join("; ")} for ${client} in ${target}; hooks that are not osnova's are kept, the file is re-serialized with its indent.${client === "codex" ? " Codex skips new or changed hooks until you trust them: open /hooks in Codex and trust the osnova entries." : ""}` };
}

// `<prefix> hook <name><tail>`: the executable part, the hook name and whatever flags follow it.
function splitHook(command: string): { prefix: string; name: string; tail: string } | undefined {
  const match = /^(\S.*?)\s+hook\s+([\w-]+)(?![\w-])(.*)$/s.exec(command);
  return match === null ? undefined : { prefix: match[1]!, name: match[2]!, tail: match[3]! };
}

// No shell operators, and each side of `hook <name>` closes its own quotes, so the prefix is a whole command.
function plainCommand(hook: { prefix: string; tail: string }): boolean {
  const balanced = (text: string): boolean => (text.match(/"/g)?.length ?? 0) % 2 === 0 && (text.match(/'/g)?.length ?? 0) % 2 === 0;
  return !/[;&|`$<>()]/.test(hook.prefix + hook.tail) && balanced(hook.prefix) && balanced(hook.tail);
}

// The shipped integration file for a client that runs plugins instead of hooks, copied into its plugin directory.
// Unchanged when the same bytes are already there; a differing file is a conflict, never overwritten.
export const pluginClients = ["opencode", "kilo", "pi"] as const;
export type PluginClient = (typeof pluginClients)[number];
export function pluginSource(client: PluginClient): string {
  // The package root holds integrations/ next to dist/ (published) or src/ (checkout); walk up to it.
  let root = path.dirname(fileURLToPath(import.meta.url));
  for (let level = 0; level < 4 && !existsSync(path.join(root, "integrations")); level += 1) root = path.dirname(root);
  return client === "pi" ? path.join(root, "integrations", "pi", "osnova.ts") : path.join(root, "integrations", "opencode", "osnova.js");
}
export function pluginTarget(client: PluginClient, home: string): string {
  if (client === "pi") return path.join(home, ".pi", "agent", "extensions", "osnova.ts");
  return path.join(home, ".config", client, "plugins", "osnova.js");
}
export async function planPlugin(client: PluginClient, options: { home?: string | undefined; source?: string | undefined }): Promise<PlannedChange> {
  const home = path.resolve(options.home ?? os.homedir());
  const target = pluginTarget(client, home);
  const source = await fs.readFile(options.source ?? pluginSource(client), "utf8");
  const pluginLink = await linkedPart(target, home);
  const existing = pluginLink === undefined ? await readOptional(target) : await readLinked(target);
  if (existing === source) return { kind: "plugin", path: target, action: "unchanged", diff: "", merged: existing, notice: `${target} is already this osnova ${client === "pi" ? "extension" : "plugin"}.` };
  if (pluginLink !== undefined) return { kind: "plugin", path: target, action: "conflict", linked: true, diff: "", merged: existing ?? "", notice: `${pluginLink} is a link; osnova never writes through a link. Replace it with a plain file or compare by hand.` };
  if (existing !== null) return { kind: "plugin", path: target, action: "conflict", diff: unifiedDiff(target, existing, source), merged: existing, notice: `${target} exists with other content; osnova never overwrites a plugin file. Remove it or compare by hand.` };
  return { kind: "plugin", path: target, action: "create", diff: unifiedDiff(target, "", source), merged: source, notice: `${client === "pi" ? "Pi loads extensions from ~/.pi/agent/extensions/ at start." : `${client} loads plugins from ${path.dirname(target)} at start.`} The file shells out to the osnova on PATH (or OSNOVA_BIN).` };
}

// The shipped Claude Code skill, copied once into ~/.claude/skills/osnova/; a differing file is a conflict.
export function skillSource(): string {
  return path.join(path.dirname(path.dirname(pluginSource("opencode"))), "claude-code", "skills", "osnova", "SKILL.md");
}
export function skillTarget(home: string): string {
  return path.join(home, ".claude", "skills", "osnova", "SKILL.md");
}
// The shared Agent Skills folder: Codex, OpenCode, Kilo and Pi load skills from ~/.agents/skills/ at start.
export function agentsSkillTarget(home: string): string {
  return path.join(home, ".agents", "skills", "osnova", "SKILL.md");
}
export async function planSkill(options: { home?: string | undefined; source?: string | undefined; shared?: boolean | undefined }): Promise<PlannedChange> {
  const home = path.resolve(options.home ?? os.homedir());
  const target = options.shared === true ? agentsSkillTarget(home) : skillTarget(home);
  const source = await fs.readFile(options.source ?? skillSource(), "utf8");
  const skillLink = await linkedPart(target, home);
  const existing = skillLink === undefined ? await readOptional(target) : await readLinked(target);
  if (existing === source) return { kind: "skill", path: target, action: "unchanged", diff: "", merged: existing, notice: `${target} is already this osnova skill.` };
  if (skillLink !== undefined) return { kind: "skill", path: target, action: "conflict", linked: true, diff: "", merged: existing ?? "", notice: `${skillLink} is a link; osnova never writes through a link. Replace it with a plain folder or compare by hand.` };
  if (existing !== null) return { kind: "skill", path: target, action: "conflict", diff: unifiedDiff(target, existing, source), merged: existing, notice: `${target} exists with other content; osnova never overwrites a skill file. Remove it or compare by hand.` };
  return { kind: "skill", path: target, action: "create", diff: unifiedDiff(target, "", source), merged: source, notice: `${options.shared === true ? "Codex, OpenCode, Kilo and Pi load skills from ~/.agents/skills/" : "Claude Code loads skills from ~/.claude/skills/"} at start; the skill's description decides when it is used.` };
}

// The instructions block for an AGENTS.md or CLAUDE.md, appended once between markers and never rewritten.
// A pointer and the two reading rules only; the MCP server's `instructions` carry the tool list.
export function instructionsBlock(): string {
  return [
    instructionsStart,
    "## Osnova",
    "",
    "This repository is indexed by Osnova, an MCP server of `osnova_*` tools: a deterministic call graph with exact file:line, no type inference. Use them before grep and file reads; start with osnova_footing, finish a change with osnova_settle.",
    "No indexed callers is not proof of absence; an unresolved edge is a lead, not a relationship.",
    instructionsEnd,
  ].join("\n");
}

export async function planInstructions(file: string): Promise<PlannedChange> {
  const target = path.resolve(file);
  const existing = await readOptional(target);
  if (existing !== null && existing.includes(instructionsStart)) return { kind: "instructions", path: target, action: "unchanged", diff: "", merged: existing, notice: `${target} already carries the osnova block.` };
  const block = instructionsBlock();
  const merged = existing === null || existing.trim().length === 0 ? `${block}\n` : `${existing.replace(/\s*$/, "")}\n\n${block}\n`;
  return { kind: "instructions", path: target, action: existing === null ? "create" : "append", diff: unifiedDiff(target, existing ?? "", merged), merged, notice: `The block sits between ${instructionsStart} and ${instructionsEnd}; osnova never touches it again.` };
}

// Families: one command per kind of harness. "claude" is Claude Code (MCP entry, hooks, skill); "agents" is every
// installed harness that reads AGENTS.md (MCP entry plus its hooks, plugin or extension) and one shared skill.
// A harness counts as installed when its config folder exists. A skill or plugin file that differs from the
// shipped one is kept and reported instead of stopping the run; an MCP or hook conflict still stops it.
export const setupFamilies = ["claude", "agents"] as const;
export type SetupFamily = (typeof setupFamilies)[number];
export const agentHarnesses = ["codex", "opencode", "kilo", "pi", "cursor"] as const;
export type AgentHarness = (typeof agentHarnesses)[number];
export function harnessFolder(harness: AgentHarness, home: string): string {
  if (harness === "codex") return path.join(home, ".codex");
  if (harness === "cursor") return path.join(home, ".cursor");
  if (harness === "pi") return path.join(home, ".pi", "agent");
  return path.join(home, ".config", harness);
}
export interface FamilyPlan {
  readonly changes: readonly (PlannedChange & { readonly client?: SetupClientId | undefined })[];
  readonly kept: readonly PlannedChange[];
  readonly skipped: readonly { readonly harness: AgentHarness; readonly reason: string }[];
}
export async function planFamily(family: SetupFamily, options: { home?: string | undefined; command?: readonly string[] | undefined; nudge?: boolean | undefined; only?: readonly AgentHarness[] | undefined }): Promise<FamilyPlan> {
  const home = path.resolve(options.home ?? os.homedir());
  const changes: (PlannedChange & { readonly client?: SetupClientId | undefined })[] = [];
  const skipped: { harness: AgentHarness; reason: string }[] = [];
  if (family === "claude") {
    changes.push({ ...(await planMcp("claude-code", { home, command: options.command })), client: "claude-code" });
    changes.push(await planHooks({ home, command: options.command, client: "claude-code", nudge: options.nudge }));
    changes.push(await planSkill({ home }));
  } else {
    for (const harness of agentHarnesses) {
      if (options.only !== undefined && !options.only.includes(harness)) continue;
      const folder = harnessFolder(harness, home);
      if (!existsSync(folder)) { skipped.push({ harness, reason: `not installed (${folder} not found)` }); continue; }
      changes.push({ ...(await planMcp(harness, { home, command: options.command })), client: harness });
      if (harness === "codex" || harness === "cursor") changes.push(await planHooks({ home, command: options.command, client: harness, nudge: options.nudge }));
      else changes.push(await planPlugin(harness, { home }));
    }
    if (changes.length > 0) changes.push(await planSkill({ home, shared: true }));
  }
  const keptKinds = new Set<PlannedChange["kind"]>(["skill", "plugin"]);
  return {
    changes: changes.filter((change) => !(change.action === "conflict" && keptKinds.has(change.kind))),
    kept: changes.filter((change) => change.action === "conflict" && keptKinds.has(change.kind)),
    skipped,
  };
}

/** A write that failed part way: `applied` lists the changes already made, with their backups. */
export class SetupApplyError extends Error {
  constructor(message: string, readonly applied: readonly AppliedChange[]) { super(message); }
}

export async function applyChanges(changes: readonly PlannedChange[]): Promise<AppliedChange[]> {
  const conflict = changes.find((change) => change.action === "conflict");
  if (conflict !== undefined) throw new Error(`osnova setup: ${conflict.path} conflicts with the proposal; nothing was written. ${conflict.notice}`);
  const applied: AppliedChange[] = [];
  try { await applyEach(changes, applied); }
  catch (error) { throw new SetupApplyError(`osnova setup: stopped after ${applied.filter((change) => change.written).length} change(s): ${error instanceof Error ? error.message : String(error)}`, applied); }
  return applied;
}

async function applyEach(changes: readonly PlannedChange[], applied: AppliedChange[]): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const change of changes) {
    if (change.action === "unchanged") { applied.push({ ...change, written: false }); continue; }
    let backup: string | undefined;
    if (change.action === "append" || change.action === "update" || change.action === "remove" || change.action === "delete") { backup = `${change.path}.bak-osnova-${stamp}`; await fs.copyFile(change.path, backup); }
    if (change.action === "delete") {
      await fs.rm(change.path);
      // A skill folder osnova created holds only SKILL.md; with it gone (and its backup beside it moved out), drop the folder.
      if (change.kind === "skill") backup = await removeEmptySkillFolder(change.path, backup);
      applied.push({ ...change, written: true, backup });
      continue;
    }
    await fs.mkdir(path.dirname(change.path), { recursive: true });
    await fs.writeFile(change.path, change.merged);
    applied.push({ ...change, written: true, backup });
  }
}

// A re-serialized file keeps the line endings it had.
function withEol(text: string, existing: string | null): string {
  return existing !== null && existing.includes("\r\n") ? text.replace(/\r?\n/g, "\r\n") : text;
}

// The first symbolic link, dangling or not, among the file and every folder between it and home: writing there
// would land wherever the link points, such as a dotfiles checkout.
// path.relative, not a prefix test: a home at a filesystem root ("/" or "C:\\") would otherwise gain a doubled separator.
export function isBelowHome(home: string, candidate: string): boolean {
  const relative = path.relative(home, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function linkedPart(target: string, home: string): Promise<string | undefined> {
  for (let candidate = target; isBelowHome(home, candidate); candidate = path.dirname(candidate)) {
    const stat = await fs.lstat(candidate).catch(() => undefined);
    if (stat?.isSymbolicLink() === true) return candidate;
  }
  return undefined;
}

// Content behind a link may be unreadable (a loop, a missing target); treat it as absent rather than failing the run.
async function readLinked(file: string): Promise<string | null> {
  try { return await readOptional(file); } catch { return null; }
}

async function readOptional(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

// The skill backup would keep the folder alive, so it moves next to the folder, as osnova-SKILL.md.bak-osnova-<stamp>.
async function removeEmptySkillFolder(file: string, backup: string | undefined): Promise<string | undefined> {
  const folder = path.dirname(file);
  const moved = backup === undefined ? undefined : path.join(path.dirname(folder), `osnova-${path.basename(backup)}`);
  if (backup !== undefined && moved !== undefined) await fs.rename(backup, moved);
  await fs.rmdir(folder).catch(() => undefined);
  return moved;
}

// Uninstall: the reverse of each planner above. Only osnova's own parts go; anything else, or anything changed since
// it was installed, is kept and reported. Every edited or deleted file is backed up first.
export async function planMcpRemoval(client: SetupClientId, options: { home?: string | undefined }): Promise<PlannedChange> {
  const removal = await previewRemoval(client, options);
  return { kind: "mcp", path: removal.path, action: removal.action, diff: removal.diff, merged: removal.merged, notice: removal.notice };
}

export async function planHookRemoval(options: { home?: string | undefined; client?: HookClient | undefined }): Promise<PlannedChange[]> {
  const client = options.client ?? "claude-code";
  const home = path.resolve(options.home ?? os.homedir());
  const target = client === "codex" ? path.join(home, ".codex", "hooks.json") : client === "cursor" ? path.join(home, ".cursor", "hooks.json") : path.join(home, ".claude", "settings.json");
  const link = await linkedPart(target, home);
  if (link !== undefined) return [{ kind: "hooks", path: target, action: "conflict", linked: true, diff: "", merged: "", notice: `${link} is a link; osnova never edits a config through a link. Remove the osnova hooks by hand.` }];
  const existing = await readOptional(target);
  if (existing === null || existing.trim().length === 0) return [{ kind: "hooks", path: target, action: "unchanged", diff: "", merged: existing ?? "", notice: `${target} has no hooks.` }];
  let parsed: unknown;
  try { parsed = JSON.parse(existing); } catch (error) { throw new Error(`osnova setup: cannot parse ${target} as JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`osnova setup: ${target} is not a JSON object`);
  const root = parsed as Record<string, unknown>;
  if (root.hooks === null || typeof root.hooks !== "object" || Array.isArray(root.hooks)) return [{ kind: "hooks", path: target, action: "unchanged", diff: "", merged: existing, notice: `${target} has no hooks.` }];
  const hooks = { ...(root.hooks as Record<string, unknown>) };
  let removed = 0;
  const wrapped = new Set<string>();
  // Returns false to drop an osnova hook; a shell-wrapped one cannot be told apart safely and stays.
  const keep = (item: unknown): boolean => {
    const command = item !== null && typeof item === "object" ? (item as { command?: unknown }).command : undefined;
    const hook = typeof command === "string" ? splitHook(command) : undefined;
    const parts = hook === undefined ? [] : hook.prefix.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    if (hook === undefined) return true;
    // Reported only: osnova run inside a shell command cannot be removed safely, so it stays.
    if (!plainCommand(hook)) { if (isOsnovaProgram(parts.at(-1) ?? "")) wrapped.add(command as string); return true; }
    if (!isOsnovaLauncher(parts)) return true;
    removed += 1;
    return false;
  };
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const groups: unknown[] = [];
    for (const group of value) {
      const inner = group !== null && typeof group === "object" ? (group as { hooks?: unknown }).hooks : undefined;
      if (!Array.isArray(inner)) { if (keep(group)) groups.push(group); continue; }
      const items = inner.filter(keep);
      if (items.length === 0 && inner.length > 0) continue;
      groups.push(items.length === inner.length ? group : { ...(group as Record<string, unknown>), hooks: items });
    }
    if (groups.length === 0 && value.length > 0) delete hooks[event];
    else hooks[event] = groups;
  }
  const changes: PlannedChange[] = [];
  if (removed === 0) changes.push({ kind: "hooks", path: target, action: "unchanged", diff: "", merged: existing, notice: `${target} has no osnova hooks to remove.` });
  else {
    const indent = /^( +|\t+)"/m.exec(existing)?.[1] ?? "  ";
    const merged = withEol(`${JSON.stringify({ ...root, hooks }, null, indent)}\n`, existing);
    changes.push({ kind: "hooks", path: target, action: "remove", diff: unifiedDiff(target, existing, merged), merged, notice: `${removed} osnova hook entr${removed === 1 ? "y" : "ies"} removed for ${client} from ${target}; hooks that are not osnova's are kept, the file is re-serialized with its indent.` });
  }
  if (wrapped.size > 0) changes.push({ kind: "hooks", path: target, action: "conflict", diff: "", merged: existing, notice: `${target} runs osnova inside a shell command (${[...wrapped].sort().join("; ")}); osnova never rewrites it. Remove it by hand.` });
  return changes;
}

// A plugin, extension or skill file is deleted only while it is byte-identical to the shipped one and no link leads to it.
async function planInstalledFile(kind: "plugin" | "skill", target: string, source: string, home: string, label: string): Promise<PlannedChange> {
  const link = await linkedPart(target, home);
  if (link !== undefined) return { kind, path: target, action: "conflict", linked: true, diff: "", merged: "", notice: `${link} is a link; osnova never removes through a link. Remove it by hand if you no longer want it.` };
  const existing = await readOptional(target);
  if (existing === null) return { kind, path: target, action: "unchanged", diff: "", merged: "", notice: `${target} is not installed.` };
  if (existing !== source) return { kind, path: target, action: "conflict", diff: "", merged: existing, notice: `${target} differs from the shipped ${label}; left in place. Remove it by hand if you no longer want it.` };
  return { kind, path: target, action: "delete", diff: unifiedDiff(target, existing, ""), merged: "", notice: `The shipped ${label} is removed.` };
}

export async function planPluginRemoval(client: PluginClient, options: { home?: string | undefined; source?: string | undefined }): Promise<PlannedChange> {
  const home = path.resolve(options.home ?? os.homedir());
  return planInstalledFile("plugin", pluginTarget(client, home), await fs.readFile(options.source ?? pluginSource(client), "utf8"), home, client === "pi" ? "Pi extension" : `${client} plugin`);
}

export async function planSkillRemoval(options: { home?: string | undefined; source?: string | undefined; shared?: boolean | undefined }): Promise<PlannedChange> {
  const home = path.resolve(options.home ?? os.homedir());
  return planInstalledFile("skill", options.shared === true ? agentsSkillTarget(home) : skillTarget(home), await fs.readFile(options.source ?? skillSource(), "utf8"), home, "osnova skill");
}

// Only the block exactly as this osnova writes it goes, with the blank line setup put before it; nothing else in the
// file changes. A file that held only the block is deleted; an edited block is kept and reported.
export async function planInstructionsRemoval(file: string): Promise<PlannedChange> {
  const target = path.resolve(file);
  const existing = await readOptional(target);
  if (existing === null || !existing.includes(instructionsStart)) return { kind: "instructions", path: target, action: "unchanged", diff: "", merged: existing ?? "", notice: `${target} has no osnova block.` };
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const block = instructionsBlock().replace(/\n/g, eol);
  if (existing === `${block}${eol}`) return { kind: "instructions", path: target, action: "delete", diff: unifiedDiff(target, existing, ""), merged: "", notice: `${target} held only the osnova block and is removed.` };
  const cut = existing.includes(`${eol}${eol}${block}`) ? `${eol}${eol}${block}` : existing.includes(`${block}${eol}`) ? `${block}${eol}` : existing.includes(block) ? block : undefined;
  if (cut === undefined) return { kind: "instructions", path: target, action: "conflict", diff: "", merged: existing, notice: `The osnova block in ${target} was edited since setup; left in place. Remove it by hand.` };
  const merged = existing.replace(cut, "");
  return { kind: "instructions", path: target, action: "remove", diff: unifiedDiff(target, existing, merged), merged, notice: `The osnova block is removed from ${target}.` };
}

export async function planUninstall(family: SetupFamily, options: { home?: string | undefined; only?: readonly AgentHarness[] | undefined; instructions?: string | undefined }): Promise<FamilyPlan> {
  const home = path.resolve(options.home ?? os.homedir());
  const changes: (PlannedChange & { readonly client?: SetupClientId | undefined })[] = [];
  const skipped: { harness: AgentHarness; reason: string }[] = [];
  if (family === "claude") {
    changes.push({ ...(await planMcpRemoval("claude-code", { home })), client: "claude-code" });
    changes.push(...await planHookRemoval({ home, client: "claude-code" }));
    changes.push(await planSkillRemoval({ home }));
  } else {
    for (const harness of agentHarnesses) {
      if (options.only !== undefined && !options.only.includes(harness)) continue;
      const folder = harnessFolder(harness, home);
      if (!existsSync(folder)) { skipped.push({ harness, reason: `not installed (${folder} not found)` }); continue; }
      changes.push({ ...(await planMcpRemoval(harness, { home })), client: harness });
      if (harness === "codex" || harness === "cursor") changes.push(...await planHookRemoval({ home, client: harness }));
      else changes.push(await planPluginRemoval(harness, { home }));
    }
    // The shared skill is read by Codex, OpenCode, Kilo and Pi; it goes only when none of those that are installed stays.
    const readers = (["codex", "opencode", "kilo", "pi"] as const).filter((harness) => existsSync(harnessFolder(harness, home)) && options.only !== undefined && !options.only.includes(harness));
    const shared = agentsSkillTarget(home);
    if (readers.length > 0 && existsSync(shared)) changes.push({ kind: "skill", path: shared, action: "conflict", diff: "", merged: "", notice: `${shared} is still read by ${readers.join(", ")}, which --only leaves installed; left in place.` });
    else changes.push(await planSkillRemoval({ home, shared: true }));
  }
  if (options.instructions !== undefined) changes.push(await planInstructionsRemoval(options.instructions));
  return { changes: changes.filter((change) => change.action !== "conflict"), kept: changes.filter((change) => change.action === "conflict"), skipped };
}

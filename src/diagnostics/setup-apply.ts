import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isOsnovaLauncher, previewSetup, unifiedDiff } from "./setup-preview.js";
import type { SetupClientId } from "./setup-preview.js";
import { hookSettingsObject, isHookEvent } from "../cli/hook.js";
import type { HookClient } from "../cli/hook.js";

// Applying a setup: every file change is planned first (path, action, diff), then written with a
// timestamped backup of whatever was there. A conflict is never resolved by writing.
export interface PlannedChange {
  readonly kind: "mcp" | "hooks" | "instructions" | "plugin" | "skill";
  readonly path: string;
  readonly action: "create" | "append" | "update" | "unchanged" | "conflict";
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
    if (hook === undefined || !isOsnovaLauncher(hook.prefix.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])) return item;
    // A shell-wrapped command cannot be rewritten safely: it still counts as present, but is never changed.
    if (!plainCommand(hook)) { if (isHookEvent(hook.name)) kept.add(hook.name); return item; }
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
  const merged = `${JSON.stringify({ ...(client === "cursor" && root.version === undefined ? { version: 1 } : {}), ...root, hooks }, null, indent)}\n`;
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
  const existing = await readOptional(target);
  if (existing === source) return { kind: "plugin", path: target, action: "unchanged", diff: "", merged: existing, notice: `${target} is already this osnova ${client === "pi" ? "extension" : "plugin"}.` };
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
export async function planSkill(options: { home?: string | undefined; source?: string | undefined }): Promise<PlannedChange> {
  const home = path.resolve(options.home ?? os.homedir());
  const target = skillTarget(home);
  const source = await fs.readFile(options.source ?? skillSource(), "utf8");
  const existing = await readOptional(target);
  if (existing === source) return { kind: "skill", path: target, action: "unchanged", diff: "", merged: existing, notice: `${target} is already this osnova skill.` };
  if (existing !== null) return { kind: "skill", path: target, action: "conflict", diff: unifiedDiff(target, existing, source), merged: existing, notice: `${target} exists with other content; osnova never overwrites a skill file. Remove it or compare by hand.` };
  return { kind: "skill", path: target, action: "create", diff: unifiedDiff(target, "", source), merged: source, notice: "Claude Code loads skills from ~/.claude/skills/ at start; the skill's description decides when it is used." };
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

export async function applyChanges(changes: readonly PlannedChange[]): Promise<AppliedChange[]> {
  const conflict = changes.find((change) => change.action === "conflict");
  if (conflict !== undefined) throw new Error(`osnova setup: ${conflict.path} conflicts with the proposal; nothing was written. ${conflict.notice}`);
  const applied: AppliedChange[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const change of changes) {
    if (change.action === "unchanged") { applied.push({ ...change, written: false }); continue; }
    let backup: string | undefined;
    if (change.action === "append" || change.action === "update") { backup = `${change.path}.bak-osnova-${stamp}`; await fs.copyFile(change.path, backup); }
    await fs.mkdir(path.dirname(change.path), { recursive: true });
    await fs.writeFile(change.path, change.merged);
    applied.push({ ...change, written: true, backup });
  }
  return applied;
}

async function readOptional(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

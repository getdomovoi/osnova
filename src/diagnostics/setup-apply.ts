import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { previewSetup, unifiedDiff } from "./setup-preview.js";
import type { SetupClientId } from "./setup-preview.js";
import { hookToolContract } from "../cli/hook.js";

// Applying a setup: every file change is planned first (path, action, diff), then written with a
// timestamped backup of whatever was there. A conflict is never resolved by writing.
export interface PlannedChange {
  readonly kind: "mcp" | "hooks" | "instructions";
  readonly path: string;
  readonly action: "create" | "append" | "unchanged" | "conflict";
  readonly diff: string;
  readonly merged: string;
  readonly notice: string;
}

export interface AppliedChange extends PlannedChange {
  readonly written: boolean;
  readonly backup?: string | undefined;
}

const hookEvents = [["SessionStart", "session", 15], ["UserPromptSubmit", "prompt", 15], ["Stop", "stop", 30]] as const;
const instructionsStart = "<!-- osnova:start -->";
const instructionsEnd = "<!-- osnova:end -->";

function quoteCommand(command: readonly string[]): string {
  return command.map((part) => (/[\s"]/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

export async function planMcp(client: SetupClientId, options: { home?: string | undefined; configPath?: string | undefined; command?: readonly string[] | undefined }): Promise<PlannedChange> {
  const preview = await previewSetup(client, options);
  return { kind: "mcp", path: preview.path, action: preview.action, diff: preview.diff, merged: preview.merged, notice: preview.notice };
}

// Claude Code hooks live in ~/.claude/settings.json; one group per event, added only when no group already runs `osnova hook <event>`.
export async function planHooks(options: { home?: string | undefined; settingsPath?: string | undefined; command?: readonly string[] | undefined }): Promise<PlannedChange> {
  const home = path.resolve(options.home ?? os.homedir());
  const target = options.settingsPath === undefined ? path.join(home, ".claude", "settings.json") : path.resolve(options.settingsPath);
  const existing = await readOptional(target);
  let root: Record<string, unknown> = {};
  if (existing !== null && existing.trim().length > 0) {
    let parsed: unknown;
    try { parsed = JSON.parse(existing); } catch (error) { throw new Error(`osnova setup: cannot parse ${target} as JSON: ${error instanceof Error ? error.message : String(error)}`); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`osnova setup: ${target} is not a JSON object`);
    root = parsed as Record<string, unknown>;
  }
  const quoted = quoteCommand(options.command ?? ["osnova"]);
  const hooks = (root.hooks !== null && typeof root.hooks === "object" && !Array.isArray(root.hooks) ? { ...(root.hooks as Record<string, unknown>) } : {});
  let added = 0;
  for (const [event, name, timeout] of hookEvents) {
    const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    const present = groups.some((group) => group !== null && typeof group === "object" && Array.isArray((group as { hooks?: unknown }).hooks) &&
      ((group as { hooks: unknown[] }).hooks).some((hook) => typeof (hook as { command?: unknown }).command === "string" && new RegExp(`\\bhook ${name}\\b`).test((hook as { command: string }).command) && /osnova/.test((hook as { command: string }).command)));
    if (present) continue;
    groups.push({ hooks: [{ type: "command", command: `${quoted} hook ${name}`, timeout }] });
    hooks[event] = groups;
    added += 1;
  }
  if (added === 0) return { kind: "hooks", path: target, action: "unchanged", diff: "", merged: existing ?? "", notice: `${target} already runs every osnova hook.` };
  const indent = existing === null ? "  " : (/^( +|\t+)"/m.exec(existing)?.[1] ?? "  ");
  const merged = `${JSON.stringify({ ...root, hooks }, null, indent)}\n`;
  const action = existing === null ? "create" : "append";
  return { kind: "hooks", path: target, action, diff: unifiedDiff(target, existing ?? "", merged), merged, notice: `${added} osnova hook group(s) for ${target}; other keys are kept, the file is re-serialized with its indent.` };
}

// The instructions block for an AGENTS.md or CLAUDE.md, appended once between markers and never rewritten.
export function instructionsBlock(): string {
  return [instructionsStart, "## Osnova", "", hookToolContract.replace(/^\[osnova\] /, ""), instructionsEnd].join("\n");
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
    if (change.action === "append") { backup = `${change.path}.bak-osnova-${stamp}`; await fs.copyFile(change.path, backup); }
    await fs.mkdir(path.dirname(change.path), { recursive: true });
    await fs.writeFile(change.path, change.merged);
    applied.push({ ...change, written: true, backup });
  }
  return applied;
}

async function readOptional(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

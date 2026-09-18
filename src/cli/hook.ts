import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { loadIndex, refreshWorkspace } from "../api.js";
import { taskContext } from "../query/task-context.js";
import { impact } from "../query/impact.js";
import { boundText } from "../query/budget.js";
import type { TaskContextResult } from "../query/task-context.js";
import type { ImpactResult } from "../query/impact.js";
import type { CliIo } from "./cli.js";

// Editor hooks: a session hook prints the tool contract, a prompt hook prints starting points for
// the prompt, a stop hook hands the agent the dependents of its uncommitted diff before it finishes.
// All read the hook payload from stdin, never touch repository files, and exit 0 on every failure
// so a hook can never block a prompt. A repository with no cache yet is indexed in the background
// from the session hook; the prompt and stop hooks answer only from an existing cache.
export type HookEvent = "prompt" | "session" | "stop" | "install-preview";
export const hookPromptCodeUnits = 1_024;
export const hookSessionCodeUnits = 1_536;
export const hookStopCodeUnits = 1_536;
const minimumPromptLength = 12;
const maximumDiffBytes = 4 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export interface HookInput {
  readonly prompt?: string | undefined;
  readonly cwd?: string | undefined;
  readonly stopHookActive?: boolean | undefined;
}

export const hookToolContract = [
  "[osnova] This repository is indexed by Osnova: a deterministic call graph with exact file:line, no type inference, no LLM. Use its tools before grep and file reads:",
  "- osnova_footing: task context for a question or named symbols (definitions, callers, candidate tests). Start here.",
  "- osnova_ground: symbol and text search ranked by definition evidence.",
  "- osnova_thread: exhaustive regex search grouped by enclosing symbol.",
  "- osnova_outline: one file's signatures and spans.",
  "- osnova_warp: callers or callees of one symbol, direct or transitive, with the resolution basis of every edge; unresolved edges list same-name candidates.",
  "- osnova_groundwork: repository map, hubs and hotspots.",
  "- osnova_settle: dependents of a unified diff before you finish a change.",
  "- osnova_plumb: check a claimed list of call sites against the index.",
  "An answer that says a symbol has no indexed callers is not proof of absence; an unresolved edge is a lead, not a relationship.",
].join("\n");

export function parseHookInput(raw: string): HookInput {
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (typeof parsed !== "object" || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  return {
    prompt: typeof record.prompt === "string" ? record.prompt : undefined,
    cwd: typeof record.cwd === "string" ? record.cwd : undefined,
    stopHookActive: typeof record.stop_hook_active === "boolean" ? record.stop_hook_active : undefined,
  };
}

// The repository root for a directory: the git top level when there is one, the directory otherwise.
export function workspaceRootFor(dir: string): string {
  try {
    const top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return top.length > 0 ? top : path.resolve(dir);
  } catch { return path.resolve(dir); }
}

export function hookSettingsSnippet(command: readonly string[]): string {
  const quoted = command.map((part) => (/[\s"]/.test(part) ? JSON.stringify(part) : part)).join(" ");
  const entry = (event: HookEvent, timeout: number) => ({ hooks: [{ type: "command", command: `${quoted} hook ${event}`, timeout }] });
  return JSON.stringify({ hooks: { SessionStart: [entry("session", 15)], UserPromptSubmit: [entry("prompt", 15)], Stop: [entry("stop", 30)] } }, null, 2);
}

export interface HookOptions {
  readonly workspace?: string | undefined;
  readonly cacheDir?: string | undefined;
  readonly command?: readonly string[] | undefined;
  /** How to start a background build; defaults to this executable. Tests pass a no-op. */
  readonly backgroundBuild?: ((workspace: string, cacheDir: string | undefined) => void) | undefined;
}

function defaultBackgroundBuild(workspace: string, cacheDir: string | undefined): void {
  const script = process.argv[1];
  if (script === undefined) return;
  const child = spawn(process.execPath, [script, "build", workspace, ...(cacheDir === undefined ? [] : ["--cache-dir", cacheDir])], { detached: true, stdio: "ignore" });
  child.unref();
}

export async function runHook(event: HookEvent, raw: string, io: CliIo, options: HookOptions): Promise<void> {
  if (event === "install-preview") {
    io.stdout([
      "osnova hook preview: add these hooks to the client's settings (Claude Code: ~/.claude/settings.json). osnova never edits that file.",
      hookSettingsSnippet(options.command ?? ["osnova"]),
    ].join("\n"));
    return;
  }
  const input = parseHookInput(raw);
  const workspace = options.workspace ?? workspaceRootFor(input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const fail = (error: unknown): void => io.stderr(`osnova hook: ${error instanceof Error ? error.message : String(error)}`);
  if (event === "session") {
    try {
      const cached = await loadIndex(workspace, { cacheDir: options.cacheDir });
      if (cached === undefined) {
        (options.backgroundBuild ?? defaultBackgroundBuild)(workspace, options.cacheDir);
        io.stdout(boundText(`${hookToolContract}\nIndex: building in the background; starting points appear from the next prompt.`, hookSessionCodeUnits));
        return;
      }
      const index = await refreshWorkspace(workspace, { cacheDir: options.cacheDir });
      io.stdout(boundText(`${hookToolContract}\nIndexed: ${index.files.size} files, ${index.symbols.size} symbols.`, hookSessionCodeUnits));
    } catch (error) { fail(error); }
    return;
  }
  if (event === "stop") {
    if (input.stopHookActive === true || process.env.OSNOVA_HOOK_SETTLE === "off") return;
    try {
      const cached = await loadIndex(workspace, { cacheDir: options.cacheDir });
      if (cached === undefined) return;
      const { stdout: diff } = await execFileAsync("git", ["-C", workspace, "diff", "HEAD", "--no-color", "--no-ext-diff"], { encoding: "utf8", maxBuffer: maximumDiffBytes });
      if (diff.trim().length === 0) return;
      const index = await refreshWorkspace(workspace, { cacheDir: options.cacheDir });
      const result = impact(index, index, { diff, maxDepth: 1 });
      const dependents = result.dependents.filter((dependent) => dependent.snapshot === "current");
      if (dependents.length === 0) return;
      io.stdout(JSON.stringify({ decision: "block", reason: boundText(formatStopReason(result), hookStopCodeUnits) }));
    } catch (error) { fail(error); }
    return;
  }
  const prompt = (input.prompt ?? "").trim();
  if (prompt.length < minimumPromptLength || prompt.startsWith("/")) return;
  try {
    const cached = await loadIndex(workspace, { cacheDir: options.cacheDir });
    if (cached === undefined) return;
    const index = await refreshWorkspace(workspace, { cacheDir: options.cacheDir });
    const header = "[osnova] starting points for this prompt (indexed graph, exact file:line; osnova_footing for the full context, osnova_warp <symbol> for callers):";
    const available = hookPromptCodeUnits - header.length - 1;
    const result = taskContext(index, { task: "understand", question: prompt, limit: 8, maxDepth: 1, maxCodeUnits: available, excerptLines: 1, measure: (partial) => formatStartingPoints(partial).length });
    const text = formatStartingPoints(result);
    if (!text.startsWith("- ")) return;
    io.stdout(`${header}\n${boundText(text, available)}`);
  } catch (error) { fail(error); }
}

// One line per definition and per relationship: enough to name where to look, small enough for every prompt.
const STARTING_POINT_KINDS = new Set(["function", "method", "class", "interface", "struct", "enum", "trait", "module", "type"]);
export function formatStartingPoints(result: TaskContextResult): string {
  const lines: string[] = [];
  for (const definition of result.definitions) {
    const symbol = definition.symbol;
    if (!STARTING_POINT_KINDS.has(symbol.kind)) continue;
    lines.push(`- ${symbol.kind} ${symbol.qualifiedName} ${symbol.file}:${symbol.span.startLine}`);
  }
  for (const relationship of result.relationships) {
    const edge = relationship.edge;
    lines.push(`  ${edge.fromSymbol || edge.fromFile} -> ${edge.toSymbol ?? edge.toName} ${edge.kind} ${edge.fromFile}:${edge.line}`);
  }
  const omitted = result.omitted;
  if (omitted.definitions > 0 || omitted.relationships > 0) lines.push(`  omitted: ${omitted.definitions} definitions, ${omitted.relationships} relationships`);
  return lines.join("\n");
}

// The stop reason the agent reads once: the changed symbols and who depends on them, as indexed.
export function formatStopReason(result: ImpactResult): string {
  const changed = result.changes.map((change) => change.after?.symbol.qualifiedName ?? change.before?.symbol.qualifiedName ?? "<unknown>");
  const dependents = result.dependents.filter((dependent) => dependent.snapshot === "current");
  const lines = [
    `[osnova settle] The uncommitted diff touches ${changed.length} indexed symbols; ${dependents.length} indexed dependents were not part of the change. Check each dependent still holds, then finish (this notice fires once).`,
    ...dependents.map((dependent) => `- ${dependent.symbol?.qualifiedName ?? dependent.file} ${dependent.file}${dependent.symbol === null ? "" : `:${dependent.symbol.span.startLine}`}`),
  ];
  if (result.uncertainty.unresolvedEdges > 0) lines.push(`${result.uncertainty.unresolvedEdges} unresolved edges are not listed; a missing dependent is not proof of absence.`);
  return lines.join("\n");
}

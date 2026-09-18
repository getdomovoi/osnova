import { refreshWorkspace } from "../api.js";
import { taskContext } from "../query/task-context.js";
import { boundText } from "../query/budget.js";
import type { TaskContextResult } from "../query/task-context.js";
import type { CliIo } from "./cli.js";

// Editor hooks: a prompt hook prints starting points for the prompt, a session hook prints the tool
// contract. Both read the hook payload from stdin, print plain text for the agent's context, never
// touch repository files, and exit 0 on every failure so a hook can never block a prompt.
export type HookEvent = "prompt" | "session" | "install-preview";
export const hookPromptCodeUnits = 1_024;
export const hookSessionCodeUnits = 1_024;
const minimumPromptLength = 12;

export interface HookInput {
  readonly prompt?: string | undefined;
  readonly cwd?: string | undefined;
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
  };
}

export function hookSettingsSnippet(command: readonly string[]): string {
  const quoted = command.map((part) => (/[\s"]/.test(part) ? JSON.stringify(part) : part)).join(" ");
  const entry = (event: HookEvent, timeout: number) => ({ hooks: [{ type: "command", command: `${quoted} hook ${event}`, timeout }] });
  return JSON.stringify({ hooks: { SessionStart: [entry("session", 15000)], UserPromptSubmit: [entry("prompt", 15000)] } }, null, 2);
}

export async function runHook(event: HookEvent, raw: string, io: CliIo, options: { readonly workspace?: string | undefined; readonly cacheDir?: string | undefined; readonly command?: readonly string[] | undefined }): Promise<void> {
  if (event === "install-preview") {
    io.stdout([
      "osnova hook preview: add these hooks to the client's settings (Claude Code: ~/.claude/settings.json). osnova never edits that file.",
      hookSettingsSnippet(options.command ?? ["osnova"]),
    ].join("\n"));
    return;
  }
  const input = parseHookInput(raw);
  const workspace = options.workspace ?? input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  if (event === "session") {
    try {
      const index = await refreshWorkspace(workspace, { cacheDir: options.cacheDir });
      io.stdout(boundText(`${hookToolContract}\nIndexed: ${index.files.size} files, ${index.symbols.size} symbols.`, hookSessionCodeUnits));
    } catch (error) {
      io.stderr(`osnova hook: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  const prompt = (input.prompt ?? "").trim();
  if (prompt.length < minimumPromptLength || prompt.startsWith("/")) return;
  try {
    const index = await refreshWorkspace(workspace, { cacheDir: options.cacheDir });
    const header = "[osnova] starting points for this prompt (indexed graph, exact file:line; osnova_footing for the full context, osnova_warp <symbol> for callers):";
    const available = hookPromptCodeUnits - header.length - 1;
    const result = taskContext(index, { task: "understand", question: prompt, limit: 8, maxDepth: 1, maxCodeUnits: available, excerptLines: 1, measure: (partial) => formatStartingPoints(partial).length });
    const text = formatStartingPoints(result);
    if (!text.startsWith("- ")) return;
    io.stdout(`${header}\n${boundText(text, available)}`);
  } catch (error) {
    io.stderr(`osnova hook: ${error instanceof Error ? error.message : String(error)}`);
  }
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

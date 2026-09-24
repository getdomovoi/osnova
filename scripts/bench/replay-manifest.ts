import { createHash } from "node:crypto";

export type ReplayStep =
  | { id: string; kind: "query"; tool: string; args: Record<string, unknown>; required: string[]; forbidden: string[]; maxTokens: number }
  | { id: string; kind: "gate"; tool: string; input: Record<string, unknown>; expected: "allow" | "deny"; maxTokens: number }
  | { id: string; kind: "read"; file: string; start: number; end: number; maxTokens: number }
  | { id: string; kind: "edit"; file: string; text: string }
  | { id: string; kind: "prompt" };
export interface ReplayManifest { schemaVersion: 1; id: string; files: Record<string, string>; steps: ReplayStep[] }
const queries = new Set(["osnova_ground", "osnova_thread", "osnova_outline", "osnova_warp", "osnova_groundwork", "osnova_footing", "osnova_settle", "osnova_plumb", "osnova_tests", "osnova_unreferenced"]);
export const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest("hex");
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== "string") throw new Error("expected a string"); return value; }
function integer(value: unknown, min = 0, max = 100_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error("invalid integer budget/range");
  return value;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("unknown manifest property");
}
export function relativeFile(value: unknown): string {
  const file = text(value);
  if (!file || file.includes("\\") || file.includes(":") || file.includes("\0") || file.split("/").some((part) => !part || part === "." || part === ".." || part === ".git" || part === "node_modules")) throw new Error("unsafe fixture path");
  return file;
}
export function parseReplayManifest(value: unknown): ReplayManifest {
  const root = object(value);
  keys(root, ["schemaVersion", "id", "files", "steps"]);
  if (root.schemaVersion !== 1) throw new Error("unsupported replay schema");
  const id = text(root.id);
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error("invalid replay id");
  const files = Object.fromEntries(Object.entries(object(root.files)).map(([file, body]) => [relativeFile(file), text(body)]));
  if (Object.keys(files).length === 0 || Object.keys(files).length > 1000 || JSON.stringify(files).length > 8 * 1024 * 1024) throw new Error("fixture size limit");
  if (!Array.isArray(root.steps) || root.steps.length === 0 || root.steps.length > 1000) throw new Error("invalid replay steps");
  const ids = new Set<string>();
  const steps = root.steps.map((raw): ReplayStep => {
    const step = object(raw), id = text(step.id);
    if (!/^[a-z0-9-]+$/.test(id) || ids.has(id)) throw new Error("invalid or duplicate step id");
    ids.add(id);
    if (step.kind === "prompt") { keys(step, ["id", "kind"]); return { id, kind: "prompt" }; }
    if (step.kind === "edit" || step.kind === "read") {
      const file = relativeFile(step.file);
      if (!Object.hasOwn(files, file)) throw new Error("step file is not in fixture");
      if (step.kind === "edit") { keys(step, ["id", "kind", "file", "text"]); return { id, kind: "edit", file, text: text(step.text) }; }
      keys(step, ["id", "kind", "file", "start", "end", "maxTokens"]);
      const start = integer(step.start, 1), end = integer(step.end, start);
      return { id, kind: "read", file, start, end, maxTokens: integer(step.maxTokens) };
    }
    if (step.kind === "gate") {
      keys(step, ["id", "kind", "tool", "input", "expected", "maxTokens"]);
      if (step.expected !== "allow" && step.expected !== "deny") throw new Error("invalid gate expectation");
      return { id, kind: "gate", tool: text(step.tool), input: object(step.input), expected: step.expected, maxTokens: integer(step.maxTokens) };
    }
    if (step.kind !== "query") throw new Error("unknown replay step");
    keys(step, ["id", "kind", "tool", "args", "required", "forbidden", "maxTokens"]);
    const tool = text(step.tool);
    if (!queries.has(tool)) throw new Error("only Osnova queries can be replayed");
    const args = object(step.args);
    if (args.baseRef !== undefined) throw new Error("replay uses inline fixtures, not git refs");
    if (args.file !== undefined) relativeFile(args.file);
    if (args.in !== undefined && args.in !== ".") relativeFile(args.in);
    if (!Array.isArray(step.required) || step.required.length === 0 || !Array.isArray(step.forbidden)) throw new Error("query requires answer anchors");
    const required = step.required.map(text), forbidden = step.forbidden.map(text);
    if ([...required, ...forbidden].some((s) => s.length === 0)) throw new Error("empty answer anchor");
    return { id, kind: "query", tool, args, required, forbidden, maxTokens: integer(step.maxTokens) };
  });
  return { schemaVersion: 1, id, files, steps };
}

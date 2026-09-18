import type { EdgeBinding, EdgeEvidence, EdgeKind, EdgeResolution, FileCard, OsnovaEdge } from "../types.js";
import { sha256Hex } from "./scan.js";

export const edgeKinds: readonly EdgeKind[] = ["calls", "references", "imports"];

export interface EdgeLayout {
  readonly bytes: Buffer;
  readonly hash: string;
  readonly count: number;
}

interface EdgeHeader {
  readonly formatVersion: 9;
  readonly count: number;
  readonly evidence: readonly EdgeEvidence[];
  readonly bindings: readonly EdgeBinding[];
}

type Tuple = [kind: number, fromFile: number, fromSymbol: string, toName: string, line: number, toSymbol: string | null, toFile: number, evidence: number, binding: number];

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item);
}

function intern<T>(values: Iterable<T | undefined>): { table: T[]; indexOf: (value: T | undefined) => number } {
  const byKey = new Set<string>();
  for (const value of values) if (value !== undefined) byKey.add(canonical(value));
  const keys = [...byKey].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const position = new Map(keys.map((key, i) => [key, i]));
  return { table: keys.map((key) => JSON.parse(key) as T), indexOf: (value) => value === undefined ? -1 : position.get(canonical(value))! };
}

export function serializeEdges(edges: readonly OsnovaEdge[], paths: readonly string[]): EdgeLayout {
  const pathIndex = new Map(paths.map((p, i) => [p, i]));
  const evidence = intern(edges.map((edge) => edge.evidence ?? { source: "unknown" as const }));
  const bindings = intern(edges.map((edge) => edge.binding));
  const header: EdgeHeader = { formatVersion: 9, count: edges.length, evidence: evidence.table, bindings: bindings.table };
  const lines = [JSON.stringify(header)];
  for (const edge of edges) {
    const fromFile = pathIndex.get(edge.fromFile);
    const toFile = edge.toFile === undefined ? -1 : pathIndex.get(edge.toFile);
    if (fromFile === undefined || toFile === undefined) throw new Error(`osnova: edge references unknown file ${edge.fromFile}`);
    const kind = edgeKinds.indexOf(edge.kind);
    if (kind < 0) throw new Error(`osnova: unknown edge kind ${JSON.stringify(edge.kind)}`);
    const tuple: Tuple = [kind, fromFile, edge.fromSymbol, edge.toName, edge.line, edge.toSymbol ?? null, toFile,
      evidence.indexOf(edge.evidence ?? { source: "unknown" }), bindings.indexOf(edge.binding)];
    lines.push(JSON.stringify(tuple));
  }
  const bytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
  return { bytes, hash: sha256Hex(bytes), count: edges.length };
}

function integerIn(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

export function validateEvidence(value: unknown): EdgeEvidence {
  if (typeof value === "object" && value !== null) {
    const evidence = value as { source?: unknown; resolution?: unknown };
    if (evidence.source === "unknown") return { source: "unknown" };
    if (evidence.source === "syntax" && typeof evidence.resolution === "object" && evidence.resolution !== null) {
      const resolution = evidence.resolution as Partial<EdgeResolution>;
      if (resolution.status === "resolved" && ["import-path", "same-file-name", "imported-file-name", "unique-name", "import-binding", "lexical-definition"].includes(resolution.method ?? "")) {
        return value as EdgeEvidence;
      }
      if (resolution.status === "resolved" && resolution.method === "re-export-binding" && validHops(resolution.via)) return value as EdgeEvidence;
      if (resolution.status === "resolved" && resolution.method === "receiver-hint" &&
        typeof resolution.receiver === "object" && resolution.receiver !== null &&
        typeof resolution.receiver.classSymbol === "string" && ["class", "instance"].includes(resolution.receiver.mode) &&
        ["constructor", "lexical", "class-reference", "annotation", "return"].includes(resolution.receiver.basis) &&
        (resolution.via === undefined || validHops(resolution.via))) return value as EdgeEvidence;
      if (resolution.status === "ambiguous" && Array.isArray(resolution.candidates) &&
        resolution.candidates.length > 1 && resolution.candidates.every((candidate: unknown) => typeof candidate === "string")) {
        return value as EdgeEvidence;
      }
      if (resolution.status === "unresolved" && ["no-matching-symbol", "import-target-unresolved", "binding-blocked", "bound-symbol-missing", "re-export-incomplete", "re-export-cycle", "receiver-unresolved", "unbound-global"].includes(resolution.reason ?? "")) {
        return value as EdgeEvidence;
      }
    }
  }
  throw new Error("osnova: corrupt edge evidence metadata");
}

function validHops(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= 128 && value.every((hop: unknown) => {
    if (typeof hop !== "object" || hop === null) return false;
    const item = hop as Record<string, unknown>;
    return ["file", "source", "exportedName", "importedName", "targetFile"].every((key) => typeof item[key] === "string") &&
      (item.kind === "named" || item.kind === "star" || item.kind === "namespace") && Number.isSafeInteger(item.line) && (item.line as number) > 0;
  });
}

function validSymbolBinding(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const binding = value as Record<string, unknown>;
  return (binding.kind === "local" && typeof binding.name === "string") ||
    (binding.kind === "import" && typeof binding.source === "string" && typeof binding.importedName === "string");
}

function validOwner(value: unknown, depth = 0): boolean {
  if (validSymbolBinding(value)) return true;
  if (typeof value !== "object" || value === null || depth > 8) return false;
  const owner = value as Record<string, unknown>;
  if (owner.kind === "super") return validSymbolBinding(owner.of);
  if (owner.kind === "field") return typeof owner.member === "string" && validOwner(owner.of, depth + 1);
  if (owner.kind === "element") return (owner.mode === undefined || owner.mode === "value" || owner.mode === "either") && validOwner(owner.of, depth + 1);
  if (owner.kind !== "return") return false;
  if (owner.index !== undefined && !(Number.isSafeInteger(owner.index) && (owner.index as number) >= 0)) return false;
  if (owner.unwrapped !== undefined && owner.unwrapped !== true) return false;
  const of = owner.of as Record<string, unknown> | undefined;
  if (validSymbolBinding(of)) return true;
  return typeof of === "object" && of !== null && of.kind === "method" && typeof of.member === "string" && (of.mode === undefined || ["instance", "class"].includes(String(of.mode))) && validOwner(of.owner, depth + 1);
}

export function validateBinding(value: unknown): EdgeBinding {
  if (typeof value === "object" && value !== null) {
    const binding = value as Partial<EdgeBinding>;
    if (binding.kind === "import" && typeof binding.source === "string" && typeof binding.importedName === "string") return value as EdgeBinding;
    if (binding.kind === "local" && typeof binding.name === "string") return value as EdgeBinding;
    if (binding.kind === "blocked" && ["local-value", "unsupported", "ambiguous", "unknown-receiver", "unbound"].includes(binding.reason ?? "")) return value as EdgeBinding;
    if (binding.kind === "instance" && validOwner(binding.owner) && ["constructor", "lexical", "annotation", "return"].includes(binding.basis ?? "")) return value as EdgeBinding;
    if (binding.kind === "member" && validOwner(binding.owner) && typeof binding.member === "string" &&
      ["instance", "class"].includes(binding.mode ?? "") && ["constructor", "lexical", "class-reference", "annotation", "return"].includes(binding.basis ?? "")) return value as EdgeBinding;
  }
  throw new Error("osnova: corrupt binding metadata");
}

export function deserializeEdges(bytes: Buffer, paths: readonly string[], files: ReadonlyMap<string, FileCard>): OsnovaEdge[] {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error("osnova: corrupt edge section");
  const lines = text.slice(0, -1).split("\n");
  const header = JSON.parse(lines[0] ?? "null") as Partial<EdgeHeader> | null;
  if (header === null || header.formatVersion !== 9 || !Array.isArray(header.evidence) || !Array.isArray(header.bindings) ||
    !integerIn(header.count, 0, Number.MAX_SAFE_INTEGER) || header.count !== lines.length - 1) throw new Error("osnova: corrupt edge header");
  const evidenceTable = header.evidence.map((entry) => validateEvidence(entry));
  const bindingTable = header.bindings.map((entry) => validateBinding(entry));
  const out: OsnovaEdge[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const tuple = JSON.parse(lines[i]!) as unknown;
    if (!Array.isArray(tuple) || tuple.length !== 9) throw new Error("osnova: corrupt edge tuple");
    const [k, f, fs, t, l, ts, tf, e, b] = tuple as Tuple;
    if (!integerIn(k, 0, edgeKinds.length - 1) || !integerIn(f, 0, paths.length - 1) || typeof fs !== "string" || typeof t !== "string" ||
      !integerIn(l, 1, Number.MAX_SAFE_INTEGER) || (ts !== null && typeof ts !== "string") || !integerIn(tf, -1, paths.length - 1) ||
      !integerIn(e, 0, evidenceTable.length - 1) || !integerIn(b, -1, bindingTable.length - 1)) throw new Error("osnova: corrupt edge tuple");
    const fromFile = paths[f]!;
    const card = files.get(fromFile);
    if (card === undefined || l > card.lineCount || (fs !== "" && fs !== fromFile && !fs.startsWith(`${fromFile}#`))) throw new Error("osnova: corrupt edge metadata");
    const toFile = tf === -1 ? undefined : paths[tf];
    if (toFile !== undefined && !files.has(toFile)) throw new Error("osnova: corrupt edge metadata");
    out.push({
      kind: edgeKinds[k]!, fromFile, fromSymbol: fs, toName: t, line: l, evidence: evidenceTable[e]!,
      ...(ts === null ? {} : { toSymbol: ts }),
      ...(toFile === undefined ? {} : { toFile }),
      ...(b === -1 ? {} : { binding: bindingTable[b]! }),
    });
  }
  return out;
}

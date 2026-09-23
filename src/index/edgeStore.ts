import type { EdgeBinding, EdgeEvidence, EdgeKind, EdgeResolution, ExportHop, FileCard, OsnovaEdge, ReceiverBasis, ReceiverMode, RouteInfo } from "../types.js";
import { sha256Hex } from "./scan.js";

// The position in this list is the stored encoding of an edge's kind, so the order is written down
// rather than left to the order of a literal. A new kind takes the next number; renumbering one
// reinterprets every stored edge and needs a format version bump.
const edgeKindWireOrder = { calls: 0, references: 1, imports: 2, extends: 3, routes: 4 } satisfies Record<EdgeKind, number>;
export const edgeKinds: readonly EdgeKind[] = (Object.keys(edgeKindWireOrder) as EdgeKind[])
  .sort((a, b) => edgeKindWireOrder[a] - edgeKindWireOrder[b]);

// A literal Record<T, true> must name every member of T and nothing else, so a validator built from
// one cannot drift from its union: a new member is a compile error here, not an artifact that the
// reader rejects as corrupt right after the writer produced it.
export const membersOf = <T extends string>(members: Record<T, true>): ReadonlySet<string> => new Set(Object.keys(members));

type PlainResolvedMethod = Extract<EdgeResolution, { status: "resolved"; via?: undefined }>["method"];
type UnresolvedReason = Extract<EdgeResolution, { status: "unresolved" }>["reason"];
type BlockedReason = Extract<EdgeBinding, { kind: "blocked" }>["reason"];
type InstanceBasis = Extract<EdgeBinding, { kind: "instance" }>["basis"];

const plainResolvedMethods = membersOf<PlainResolvedMethod>({
  "import-path": true, "same-file-name": true, "imported-file-name": true, "unique-name": true, "import-binding": true, "lexical-definition": true,
});
const unresolvedReasons = membersOf<UnresolvedReason>({
  "no-matching-symbol": true, "import-target-unresolved": true, "import-target-ambiguous": true, "binding-blocked": true,
  "bound-symbol-missing": true, "shadowed-declaration": true, "route-handler-inline": true, "route-handler-wrapped": true,
  "re-export-incomplete": true, "re-export-cycle": true, "receiver-unresolved": true, "unbound-global": true,
});
const receiverModes = membersOf<ReceiverMode>({ instance: true, class: true });
const receiverBases = membersOf<ReceiverBasis>({ constructor: true, lexical: true, "class-reference": true, annotation: true, return: true });
const blockedReasons = membersOf<BlockedReason>({
  "local-value": true, unsupported: true, ambiguous: true, "unknown-receiver": true, unbound: true, "inline-handler": true, "wrapped-handler": true,
});
const instanceBases = membersOf<InstanceBasis>({ constructor: true, lexical: true, annotation: true, return: true });
const exportHopKinds = membersOf<ExportHop["kind"]>({ named: true, star: true, namespace: true });

export interface EdgeLayout {
  readonly bytes: Buffer;
  readonly hash: string;
  readonly count: number;
}

interface EdgeHeader {
  readonly formatVersion: 11;
  readonly count: number;
  readonly evidence: readonly EdgeEvidence[];
  readonly bindings: readonly EdgeBinding[];
  readonly routes: readonly RouteInfo[];
}

type Tuple = [kind: number, fromFile: number, fromSymbol: string, toName: string, line: number, toSymbol: string | null, toFile: number, evidence: number, binding: number, route: number];

const MAX_ARRAY_INDEX = 4294967294;

function arrayIndexOf(key: string): number {
  if (key === "0") return 0;
  if (key.length === 0 || key.length > 10 || key.charCodeAt(0) < 49 || key.charCodeAt(0) > 57) return -1;
  for (let i = 1; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    if (code < 48 || code > 57) return -1;
  }
  const index = Number(key);
  return index <= MAX_ARRAY_INDEX ? index : -1;
}

function comparePropertyKeys(a: string, b: string): number {
  const ia = arrayIndexOf(a);
  const ib = arrayIndexOf(b);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalValue(value: unknown, key: string): string | undefined {
  if (typeof value === "object" && value !== null) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") return canonicalValue((toJSON as (k: string) => unknown).call(value, key), key);
    if (Array.isArray(value)) {
      let out = "[";
      for (let i = 0; i < value.length; i += 1) {
        if (i > 0) out += ",";
        out += canonicalValue(value[i], String(i)) ?? "null";
      }
      return `${out}]`;
    }
    const keys = Object.keys(value).sort(comparePropertyKeys);
    let out = "{";
    let first = true;
    for (const name of keys) {
      const item = canonicalValue((value as Record<string, unknown>)[name], name);
      if (item === undefined) continue;
      if (!first) out += ",";
      first = false;
      out += `${JSON.stringify(name)}:${item}`;
    }
    return `${out}}`;
  }
  return JSON.stringify(value);
}

export function canonical(value: unknown): string {
  return canonicalValue(value, "") as string;
}

function intern<T>(values: readonly (T | undefined)[]): { table: T[]; ids: number[] } {
  const keys = values.map((value) => (value === undefined ? undefined : canonical(value)));
  const byKey = new Set<string>();
  for (const key of keys) if (key !== undefined) byKey.add(key);
  const sorted = [...byKey].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const position = new Map(sorted.map((key, i) => [key, i]));
  return { table: sorted.map((key) => JSON.parse(key) as T), ids: keys.map((key) => (key === undefined ? -1 : position.get(key)!)) };
}

export function serializeEdges(edges: readonly OsnovaEdge[], paths: readonly string[]): EdgeLayout {
  const pathIndex = new Map(paths.map((p, i) => [p, i]));
  const evidence = intern(edges.map((edge) => edge.evidence ?? { source: "unknown" as const }));
  const bindings = intern(edges.map((edge) => edge.binding));
  const routes = intern(edges.map((edge) => (edge.route === undefined ? undefined : validateRoute(edge.route))));
  const header: EdgeHeader = { formatVersion: 11, count: edges.length, evidence: evidence.table, bindings: bindings.table, routes: routes.table };
  const lines = [JSON.stringify(header)];
  for (const [i, edge] of edges.entries()) {
    const fromFile = pathIndex.get(edge.fromFile);
    const toFile = edge.toFile === undefined ? -1 : pathIndex.get(edge.toFile);
    if (fromFile === undefined || toFile === undefined) throw new Error(`osnova: edge references unknown file ${edge.fromFile}`);
    const kind = edgeKinds.indexOf(edge.kind);
    if (kind < 0) throw new Error(`osnova: unknown edge kind ${JSON.stringify(edge.kind)}`);
    const tuple: Tuple = [kind, fromFile, edge.fromSymbol, edge.toName, edge.line, edge.toSymbol ?? null, toFile,
      evidence.ids[i]!, bindings.ids[i]!, routes.ids[i]!];
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
      if (resolution.status === "resolved" && plainResolvedMethods.has(resolution.method ?? "")) {
        return value as EdgeEvidence;
      }
      if (resolution.status === "resolved" && resolution.method === "re-export-binding" && validHops(resolution.via)) return value as EdgeEvidence;
      if (resolution.status === "resolved" && resolution.method === "receiver-hint" &&
        typeof resolution.receiver === "object" && resolution.receiver !== null &&
        typeof resolution.receiver.classSymbol === "string" && receiverModes.has(resolution.receiver.mode) &&
        receiverBases.has(resolution.receiver.basis) &&
        (resolution.via === undefined || validHops(resolution.via))) return value as EdgeEvidence;
      if (resolution.status === "ambiguous" && Array.isArray(resolution.candidates) &&
        resolution.candidates.length > 1 && resolution.candidates.every((candidate: unknown) => typeof candidate === "string")) {
        return value as EdgeEvidence;
      }
      if (resolution.status === "unresolved" && unresolvedReasons.has(resolution.reason ?? "") &&
        (resolution.external === undefined || (typeof resolution.external === "string" && resolution.external.length > 0 && resolution.reason === "import-target-unresolved"))) {
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
      exportHopKinds.has(String(item.kind)) && Number.isSafeInteger(item.line) && (item.line as number) > 0;
  });
}

function validSymbolBinding(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const binding = value as Record<string, unknown>;
  return (binding.kind === "local" && typeof binding.name === "string") ||
    (binding.kind === "import" && typeof binding.source === "string" && typeof binding.importedName === "string");
}

export function validOwner(value: unknown, depth = 0): boolean {
  if (validSymbolBinding(value)) return true;
  if (typeof value !== "object" || value === null || depth > 16) return false;
  const owner = value as Record<string, unknown>;
  if (owner.kind === "super") return validSymbolBinding(owner.of);
  if (owner.kind === "field") return typeof owner.member === "string" && validOwner(owner.of, depth + 1);
  if (owner.kind === "element") return (owner.mode === undefined || owner.mode === "value" || owner.mode === "either") && validOwner(owner.of, depth + 1);
  if (owner.kind !== "return") return false;
  if (owner.index !== undefined && !(Number.isSafeInteger(owner.index) && (owner.index as number) >= 0)) return false;
  if (owner.unwrapped !== undefined && owner.unwrapped !== true) return false;
  const of = owner.of as Record<string, unknown> | undefined;
  if (validSymbolBinding(of)) return true;
  return typeof of === "object" && of !== null && of.kind === "method" && typeof of.member === "string" && (of.mode === undefined || receiverModes.has(String(of.mode))) && validOwner(of.owner, depth + 1);
}

export function validateBinding(value: unknown): EdgeBinding {
  if (typeof value === "object" && value !== null) {
    const binding = value as Partial<EdgeBinding>;
    if (binding.kind === "import" && typeof binding.source === "string" && typeof binding.importedName === "string") return value as EdgeBinding;
    if (binding.kind === "local" && typeof binding.name === "string") return value as EdgeBinding;
    if (binding.kind === "blocked" && blockedReasons.has(binding.reason ?? "")) return value as EdgeBinding;
    if (binding.kind === "instance" && validOwner(binding.owner) && instanceBases.has(binding.basis ?? "")) return value as EdgeBinding;
    if (binding.kind === "member" && validOwner(binding.owner) && typeof binding.member === "string" &&
      receiverModes.has(binding.mode ?? "") && receiverBases.has(binding.basis ?? "")) return value as EdgeBinding;
  }
  throw new Error("osnova: corrupt binding metadata");
}

function validateRoute(value: unknown): RouteInfo {
  const route = value as Partial<RouteInfo> | null;
  if (typeof route !== "object" || route === null || typeof route.method !== "string" || !/^[A-Z]+$/.test(route.method) ||
    (route.path !== undefined && (typeof route.path !== "string" || route.path.length > 2048))) throw new Error("osnova: corrupt route metadata");
  return route.path === undefined ? { method: route.method } : { method: route.method, path: route.path };
}

export function deserializeEdges(bytes: Buffer, paths: readonly string[], files: ReadonlyMap<string, FileCard>): OsnovaEdge[] {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error("osnova: corrupt edge section");
  const lines = text.slice(0, -1).split("\n");
  const header = JSON.parse(lines[0] ?? "null") as Partial<EdgeHeader> | null;
  if (header === null || header.formatVersion !== 11 || !Array.isArray(header.evidence) || !Array.isArray(header.bindings) || !Array.isArray(header.routes) ||
    !integerIn(header.count, 0, Number.MAX_SAFE_INTEGER) || header.count !== lines.length - 1) throw new Error("osnova: corrupt edge header");
  const evidenceTable = header.evidence.map((entry) => validateEvidence(entry));
  const bindingTable = header.bindings.map((entry) => validateBinding(entry));
  const routeTable = header.routes.map((entry) => validateRoute(entry));
  const out: OsnovaEdge[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const tuple = JSON.parse(lines[i]!) as unknown;
    if (!Array.isArray(tuple) || tuple.length !== 10) throw new Error("osnova: corrupt edge tuple");
    const [k, f, fs, t, l, ts, tf, e, b, r] = tuple as Tuple;
    if (!integerIn(k, 0, edgeKinds.length - 1) || !integerIn(f, 0, paths.length - 1) || typeof fs !== "string" || typeof t !== "string" ||
      !integerIn(l, 1, Number.MAX_SAFE_INTEGER) || (ts !== null && typeof ts !== "string") || !integerIn(tf, -1, paths.length - 1) ||
      !integerIn(e, 0, evidenceTable.length - 1) || !integerIn(b, -1, bindingTable.length - 1) || !integerIn(r, -1, routeTable.length - 1)) throw new Error("osnova: corrupt edge tuple");
    if ((edgeKinds[k] === "routes") !== (r !== -1)) throw new Error("osnova: corrupt edge metadata");
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
      ...(r === -1 ? {} : { route: routeTable[r]! }),
    });
  }
  return out;
}

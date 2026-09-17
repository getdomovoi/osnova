import type {
  CallersResult,
  CallersOptions,
  CallersDetailedResult,
  UnresolvedCallerEdge,
  NameMatches,
  CallerEvidenceHit,
  EdgeDirection,
  OsnovaIndex,
  OsnovaSymbol,
  OsnovaEdge,
} from "../types.js";
import { languageFamily } from "../index/resolve.js";

const NAME_MATCH_LIMIT = 5;

// Indexed callables that carry the same name as an unresolved call: the set a reader would have to
// check by hand. Capped, deterministic, never a resolution.
export function nameMatches(index: OsnovaIndex, edge: OsnovaEdge): NameMatches {
  const family = languageFamily(index.files.get(edge.fromFile)?.language);
  const name = edge.toName.split(".").pop() ?? edge.toName;
  const names: string[] = [];
  for (const symbol of index.symbols.values()) {
    if (symbol.name !== name || !["function", "method", "class"].includes(symbol.kind)) continue;
    if (family !== undefined && languageFamily(index.files.get(symbol.file)?.language) !== family) continue;
    names.push(symbol.qualifiedName);
  }
  names.sort();
  return { candidates: names.slice(0, NAME_MATCH_LIMIT), total: names.length };
}

function resolveTargets(index: OsnovaIndex, symbol: string): OsnovaSymbol[] {
  const exact = index.symbols.get(symbol);
  if (exact !== undefined) return [exact];
  const local = symbol.includes("#") ? symbol.slice(symbol.indexOf("#") + 1) : symbol;
  const candidates = [...index.symbols.values()].filter((s) => s.name === symbol ||
    (local.includes(".") && s.qualifiedName.endsWith(`#${local}`)));
  if (candidates.length === 0) {
    throw new Error(
      `osnova: no indexed symbol named ${JSON.stringify(symbol)}; search with thread or ground to locate the qualified name first`,
    );
  }
  candidates.sort((a, b) => {
    const diff = index.incoming(b.qualifiedName).length - index.incoming(a.qualifiedName).length;
    if (diff !== 0) return diff;
    return a.qualifiedName < b.qualifiedName ? -1 : 1;
  });
  return candidates;
}

export function callers(
  index: OsnovaIndex,
  symbol: string,
  options?: { direction?: EdgeDirection; depth?: number },
): CallersResult {
  const target = resolveTargets(index, symbol)[0] as OsnovaSymbol;
  const { hits } = walkCallers(index, target, options);
  return { target, hits: hits.map(({ edge: _edge, ...hit }) => hit) };
}

export function callersDetailed(
  index: OsnovaIndex,
  symbol: string,
  options?: CallersOptions,
): CallersDetailedResult {
  const depth = options?.depth ?? 1;
  const direction = options?.direction ?? "in";
  if (!Number.isSafeInteger(depth) || depth < 1) {
    throw new RangeError("osnova: caller depth must be a positive safe integer");
  }
  if (direction !== "in" && direction !== "out") {
    throw new RangeError("osnova: caller direction must be in or out");
  }
  const candidates = resolveTargets(index, symbol);
  if (candidates.length > 1) return { status: "ambiguous", candidates };
  const target = candidates[0] as OsnovaSymbol;
  const { hits, unresolved } = walkCallers(index, target, { direction, depth });
  return {
    status: "found", scope: "indexed-graph", direction, depth, target,
    hits: hits.filter((hit) => hit.resolved).map((hit) => direction === "out"
      ? { ...hit, line: hit.symbol?.span.startLine ?? null } : hit), unresolved,
  };
}

function walkCallers(
  index: OsnovaIndex,
  target: OsnovaSymbol,
  options?: CallersOptions,
): { hits: CallerEvidenceHit[]; unresolved: UnresolvedCallerEdge[] } {
  const direction = options?.direction ?? "in";
  const depth = Math.max(1, options?.depth ?? 1);

  const hits: CallerEvidenceHit[] = [];
  const unresolved: UnresolvedCallerEdge[] = [];
  const seenUnresolved = new Set<OsnovaEdge>();
  const unresolvedByName = new Map<string, OsnovaEdge[]>();
  if (direction === "in") {
    for (const edge of index.edges) {
      if (edge.toSymbol !== undefined || edge.kind === "imports") continue;
      const targetName = edge.binding?.kind === "import" ? edge.binding.importedName
        : edge.binding?.kind === "local" ? edge.binding.name : edge.toName;
      const name = targetName.split(".").pop() ?? targetName;
      const list = unresolvedByName.get(name) ?? [];
      list.push(edge);
      unresolvedByName.set(name, list);
    }
  }
  const visited = new Set<string>([target.qualifiedName]);
  let frontier: string[] = [target.qualifiedName];

  for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const node of frontier) {
      const edges = direction === "in" ? index.incoming(node) : index.outgoing(node);
      const candidates = direction === "in"
        ? unresolvedByName.get(index.symbols.get(node)?.name ?? "") ?? []
        : edges.filter((edge) => edge.toSymbol === undefined);
      for (const edge of candidates) {
        if (seenUnresolved.has(edge)) continue;
        seenUnresolved.add(edge);
        unresolved.push({ edge, depth: level, nameMatches: nameMatches(index, edge) });
      }
      for (const edge of edges) {
        const other =
          direction === "in"
            ? edge.fromSymbol
            : (edge.toSymbol ?? "");
        const otherSymbol = other.length > 0 ? (index.symbols.get(other) ?? null) : null;
        if (direction === "in") {
          hits.push({
            symbol: otherSymbol,
            qualifiedName: other,
            file: edge.fromFile,
            line: edge.line,
            kind: edge.kind,
            depth: level,
            resolved: true,
            edge,
          });
        } else {
          hits.push({
            symbol: otherSymbol,
            qualifiedName: other,
            file: edge.toFile ?? null,
            line: edge.line,
            kind: edge.kind,
            depth: level,
            resolved: edge.toSymbol !== undefined,
            edge,
          });
        }
        if (other.length > 0 && !visited.has(other) && index.symbols.has(other)) {
          visited.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }

  const compareStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  hits.sort(
    (a, b) =>
      a.depth - b.depth ||
      compareStr(a.file ?? "", b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      compareStr(a.kind, b.kind) ||
      compareStr(a.qualifiedName, b.qualifiedName),
  );
  unresolved.sort((a, b) =>
    a.depth - b.depth || compareStr(a.edge.fromFile, b.edge.fromFile) ||
    a.edge.line - b.edge.line || compareStr(a.edge.kind, b.edge.kind) ||
    compareStr(a.edge.toName, b.edge.toName) || compareStr(a.edge.fromSymbol, b.edge.fromSymbol));
  return { hits, unresolved };
}

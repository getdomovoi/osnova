import type {
  CallersResult,
  CallerHit,
  EdgeDirection,
  OsnovaIndex,
  OsnovaSymbol,
} from "../types.js";

function resolveTarget(index: OsnovaIndex, symbol: string): OsnovaSymbol {
  const exact = index.symbols.get(symbol);
  if (exact !== undefined) return exact;
  const candidates = [...index.symbols.values()].filter((s) => s.name === symbol);
  if (candidates.length === 0) {
    throw new Error(
      `osnova: no indexed symbol named ${JSON.stringify(symbol)}; use findText to locate names first`,
    );
  }
  candidates.sort((a, b) => {
    const diff = index.incoming(b.qualifiedName).length - index.incoming(a.qualifiedName).length;
    if (diff !== 0) return diff;
    return a.qualifiedName < b.qualifiedName ? -1 : 1;
  });
  return candidates[0] as OsnovaSymbol;
}

export function callers(
  index: OsnovaIndex,
  symbol: string,
  options?: { direction?: EdgeDirection; depth?: number },
): CallersResult {
  const target = resolveTarget(index, symbol);
  const direction = options?.direction ?? "in";
  const depth = Math.max(1, options?.depth ?? 1);

  const hits: CallerHit[] = [];
  const visited = new Set<string>([target.qualifiedName]);
  let frontier: string[] = [target.qualifiedName];

  for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const node of frontier) {
      const edges = direction === "in" ? index.incoming(node) : index.outgoing(node);
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

  hits.sort(
    (a, b) =>
      a.depth - b.depth ||
      (a.file ?? "").localeCompare(b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.kind.localeCompare(b.kind) ||
      a.qualifiedName.localeCompare(b.qualifiedName),
  );
  return { target, hits };
}

import type { OsnovaIndex } from "../types.js";

const cache = new WeakMap<OsnovaIndex, ReadonlyMap<string, number>>();

export function graphWeights(index: OsnovaIndex): ReadonlyMap<string, number> {
  const existing = cache.get(index);
  if (existing !== undefined) return existing;
  const callers = new Map<string, Set<string>>();
  for (const edge of index.edges) {
    if (edge.kind !== "calls" || edge.toSymbol === undefined || edge.fromSymbol === edge.toSymbol ||
      !index.symbols.has(edge.fromSymbol) || !index.symbols.has(edge.toSymbol)) continue;
    const evidence = edge.evidence;
    if (evidence?.source !== "syntax" || evidence.resolution.status !== "resolved" ||
      !["lexical-definition", "import-binding", "re-export-binding"].includes(evidence.resolution.method)) continue;
    const sources = callers.get(edge.toSymbol) ?? new Set<string>();
    sources.add(edge.fromSymbol);
    callers.set(edge.toSymbol, sources);
  }
  let maximum = 1;
  for (const sources of callers.values()) maximum = Math.max(maximum, sources.size);
  const weights = new Map([...callers].map(([name, sources]) => [name, Math.log1p(sources.size) / Math.log1p(maximum)]));
  cache.set(index, weights);
  return weights;
}

export function graphAdjustedScore(score: number, weight: number): number {
  const tier = Math.floor(score);
  return tier + 0.9 * (score - tier) + 0.1 * weight;
}

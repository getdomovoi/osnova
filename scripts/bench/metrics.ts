export function scoreRanking(actual: readonly string[], expected: readonly string[], k = 5): { recall: number; reciprocalRank: number } {
  if (!Number.isSafeInteger(k) || k < 1) throw new RangeError("ranking cutoff must be a positive integer");
  const relevant = new Set(expected);
  if (relevant.size === 0) throw new Error("ranking requires nonempty relevance labels");
  const selected = actual.slice(0, k);
  const found = new Set(selected.filter((id) => relevant.has(id)));
  const first = selected.findIndex((id) => relevant.has(id));
  return { recall: found.size / relevant.size, reciprocalRank: first < 0 ? 0 : 1 / (first + 1) };
}

export function scoreSet(actual: readonly string[], expected: readonly string[]): {
  precision: number; recall: number; truePositives: number; falsePositives: number; falseNegatives: number;
  expectedCount: number; returnedCount: number;
} {
  const returned = new Set(actual);
  const truth = new Set(expected);
  const truePositives = [...returned].filter((id) => truth.has(id)).length;
  return {
    precision: returned.size === 0 ? (truth.size === 0 ? 1 : 0) : truePositives / returned.size,
    recall: truth.size === 0 ? 1 : truePositives / truth.size,
    truePositives, falsePositives: returned.size - truePositives, falseNegatives: truth.size - truePositives,
    expectedCount: truth.size, returnedCount: returned.size,
  };
}

export function percentile(samples: readonly number[], p: number): number | null {
  if (!Number.isFinite(p) || p < 0 || p > 100 || samples.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError("percentiles require finite nonnegative samples and a percentile from 0 to 100");
  }
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length / 100) - 1)] ?? null;
}

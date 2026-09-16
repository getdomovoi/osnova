import { describe, expect, it } from "vitest";
import { percentile, scoreRanking, scoreSet } from "../scripts/bench/metrics.js";

describe("benchmark scoring", () => {
  it("penalizes missing relevant definitions and uses actual rank positions", () => {
    expect(scoreRanking(["wrong", "target"], ["target", "missing"], 5)).toEqual({ recall: 0.5, reciprocalRank: 0.5 });
    expect(scoreRanking(["wrong"], ["target"], 5)).toEqual({ recall: 0, reciprocalRank: 0 });
    expect(scoreRanking([], ["target"], 5)).toEqual({ recall: 0, reciprocalRank: 0 });
  });

  it("does not let duplicates inflate recall or recover wasted ranking slots", () => {
    expect(scoreRanking(["wrong", "wrong", "target"], ["target"], 2)).toEqual({ recall: 0, reciprocalRank: 0 });
    expect(scoreRanking(["target", "target"], ["target", "second"], 5).recall).toBe(0.5);
  });

  it("rejects ranking tasks without relevance labels", () => {
    expect(() => scoreRanking([], [], 5)).toThrow(/relevance/);
    expect(() => scoreRanking([], ["target"], 0)).toThrow(RangeError);
  });

  it("penalizes both false positive callers and missed callers", () => {
    expect(scoreSet(["a", "wrong", "a"], ["a", "b"])).toEqual({
      precision: 0.5, recall: 0.5, truePositives: 1, falsePositives: 1, falseNegatives: 1,
      expectedCount: 2, returnedCount: 2,
    });
  });

  it("keeps empty ground truth meaningful for false-positive testing", () => {
    expect(scoreSet([], [])).toMatchObject({ precision: 1, recall: 1 });
    expect(scoreSet(["unexpected"], [])).toMatchObject({ precision: 0, falsePositives: 1 });
    expect(scoreSet([], ["missing"])).toMatchObject({ precision: 0, recall: 0, falseNegatives: 1 });
  });

  it("reports nearest-rank percentiles without inventing empty measurements", () => {
    expect(percentile([4, 1, 3, 2], 50)).toBe(2);
    expect(percentile([4, 1, 3, 2], 95)).toBe(4);
    expect(percentile([], 95)).toBeNull();
  });

  it.each([NaN, Infinity, -1])("rejects invalid latency samples: %s", (sample) => {
    expect(() => percentile([sample], 50)).toThrow(RangeError);
  });
});

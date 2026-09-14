import { describe, expect, it } from "vitest";
import { runBenchmark } from "../scripts/bench/runner.js";
import { parseManifest } from "../scripts/bench/manifest.js";

function corpus() {
  return parseManifest({
    schemaVersion: 1, id: "runner-test",
    source: { kind: "inline", files: { "one.ts": "export function alpha() { return 1; }\n" } },
    edit: { file: "one.ts", append: "\n// measured edit\n" },
    cases: [
      { id: "hit", split: "development", kind: "ask", question: "alpha", expected: ["one.ts#alpha"], anchors: [{ file: "one.ts", text: "function alpha" }] },
      { id: "miss", split: "development", kind: "ask", question: "unmatchedword", expected: ["one.ts#alpha"], anchors: [{ file: "one.ts", text: "function alpha" }] },
      { id: "error", split: "development", kind: "callers", symbol: "missing", expected: ["one.ts#alpha"], anchors: [{ file: "one.ts", text: "function alpha" }] },
      { id: "text", split: "evaluation", kind: "findText", pattern: "alpha", fixed: true, expected: ["one.ts:1:16"], anchors: [{ file: "one.ts", text: "function alpha" }] },
    ],
  });
}

describe("offline benchmark runner", () => {
  it("retains hits, misses and query errors without changing product behavior", async () => {
    const manifest = corpus();
    const before = JSON.stringify(manifest);
    const result = await runBenchmark(manifest, { samples: 2, split: "development" });
    expect(result.cases).toHaveLength(3);
    expect(result.cases[0]?.ranking?.recall).toBe(1);
    expect(result.cases[1]?.ranking?.recall).toBe(0);
    expect(result.cases[2]?.status).toBe("error");
    expect(result.status).toBe("failed");
    expect(result.summary.caseCount).toBe(3);
    expect(result.summary.errorCount).toBe(1);
    expect(result.summary.meanRecallAt5).toBe(0.5);
    expect(JSON.stringify(manifest)).toBe(before);
    expect(result.unmeasured).toEqual({ taskSuccess: null, contextTokens: null, agentToolCalls: null, packageBytes: null });
    expect(result.isolation).toBe("in-process");
  });

  it("keeps evaluation cases separate and reports exact search completeness", async () => {
    const result = await runBenchmark(corpus(), { samples: 1, split: "evaluation" });
    expect(result.status).toBe("completed");
    expect(result.cases.map((item) => item.id)).toEqual(["text"]);
    expect(result.cases[0]?.set).toMatchObject({ precision: 1, recall: 1 });
    expect(result.cases[0]?.responseCodeUnits).toBeGreaterThan(0);
    expect(result.cases[0]?.responseCodeUnits).toBeLessThanOrEqual(16_384);
    expect(result.performance?.noChangeRefreshMs.samples).toHaveLength(1);
    expect(result.performance?.editedRefreshMs.samples).toHaveLength(1);
    expect(result.performance?.incrementalEqualsFull).toBe(true);
    expect(result.performance?.serializedArtifactBytes).toBeGreaterThan(0);
    expect(result.snapshotFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reports invalid source anchors instead of silently dropping a task", async () => {
    const manifest = corpus();
    const first = manifest.cases[0];
    if (first === undefined) throw new Error("missing fixture");
    const changed = { ...manifest, cases: [{ ...first, anchors: [{ file: "one.ts", text: "not in source" }] }] };
    const result = await runBenchmark(changed, { samples: 1, split: "development" });
    expect(result.status).toBe("failed");
    expect(result.cases[0]?.status).toBe("invalid");
    expect(result.summary.errorCount).toBe(1);
    expect(result.summary.meanRecallAt5).toBeNull();
  });

  it("requires an explicitly supplied checkout rather than using the current directory", async () => {
    const manifest = { ...corpus(), source: { kind: "checkout" as const, revision: "a".repeat(40) } };
    const result = await runBenchmark(manifest, { samples: 1, split: "development" });
    expect(result.status).toBe("failed");
    expect(result.errors.join("\n")).toContain("workspace required");
    expect(result.sourceRevision).toBe("a".repeat(40));
    expect(result.performance).toBeNull();
    expect(result.cases).toHaveLength(3);
    expect(result.cases.every((item) => item.status === "error")).toBe(true);
  });

  it.each([0, -1, 1.5, 101, NaN, Infinity])("rejects invalid repeat counts: %s", async (samples) => {
    await expect(runBenchmark(corpus(), { samples, split: "development" })).rejects.toThrow(RangeError);
  });

  it("does not execute queries if the evaluation source snapshot changed", async () => {
    const result = await runBenchmark(corpus(), {
      samples: 1, split: "evaluation", expectedSnapshotFingerprint: "0".repeat(64),
    });
    expect(result.status).toBe("failed");
    expect(result.errors.join("\n")).toContain("candidate snapshot mismatch");
    expect(result.performance).toBeNull();
    expect(result.cases.every((item) => item.status === "error" && item.elapsedMs === null)).toBe(true);
  });
});

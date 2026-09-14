import { describe, expect, it } from "vitest";
import { validateCandidate } from "../scripts/bench/evaluation.js";

const context = {
  corpus: "core-v1", manifestFingerprint: "a".repeat(64), engineFingerprint: "b".repeat(64), harnessFingerprint: "c".repeat(64),
  developmentCaseIds: ["one", "two"], environment: { node: "v22.13.0", platform: "linux", arch: "x64" },
};

function candidate() {
  return {
    schemaVersion: 1, status: "completed", scoringScope: "structured-query", corpus: context.corpus,
    manifestFingerprint: context.manifestFingerprint, snapshotFingerprint: "d".repeat(64),
    implementation: { engineFingerprint: context.engineFingerprint, harnessFingerprint: context.harnessFingerprint },
    environment: context.environment,
    cases: context.developmentCaseIds.map((id) => ({ id, split: "development", status: "measured" })),
  };
}

describe("evaluation receipts", () => {
  it("binds evaluation to a measured development candidate", () => {
    const receipt = validateCandidate(candidate(), context);
    expect(receipt.snapshotFingerprint).toBe("d".repeat(64));
    expect(receipt.engineFingerprint).toBe(context.engineFingerprint);
    expect(receipt.candidateReportFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(["engineFingerprint", "harnessFingerprint"] as const)("rejects changed %s", (field) => {
    const report = candidate();
    report.implementation[field] = "e".repeat(64);
    expect(() => validateCandidate(report, context)).toThrow(/candidate .* mismatch/);
  });

  it("rejects changed labels, corpus identity and runtime environment", () => {
    expect(() => validateCandidate({ ...candidate(), manifestFingerprint: "e".repeat(64) }, context)).toThrow(/manifest mismatch/);
    expect(() => validateCandidate({ ...candidate(), corpus: "other" }, context)).toThrow(/corpus mismatch/);
    expect(() => validateCandidate({ ...candidate(), environment: { ...context.environment, node: "different" } }, context)).toThrow(/environment mismatch/);
  });

  it("rejects incomplete or non-development runs", () => {
    expect(() => validateCandidate({ ...candidate(), status: "failed" }, context)).toThrow(/completed/);
    expect(() => validateCandidate({ ...candidate(), cases: [] }, context)).toThrow(/case/);
    const report = candidate();
    const first = report.cases[0];
    if (first === undefined) throw new Error("missing fixture");
    first.split = "evaluation";
    expect(() => validateCandidate(report, context)).toThrow(/development/);
  });

  it("rejects invalid receipt data rather than accepting an unknown state", () => {
    expect(() => validateCandidate(null, context)).toThrow(/candidate/);
    expect(() => validateCandidate({ ...candidate(), snapshotFingerprint: "" }, context)).toThrow(/snapshot/);
  });

  it("does not compare different ranking variants under the same receipt", () => {
    const report = { ...candidate(), queryOptions: { graphRank: false } };
    expect(() => validateCandidate(report, { ...context, queryOptions: { graphRank: true } })).toThrow(/configuration mismatch/);
    expect(validateCandidate(report, { ...context, queryOptions: { graphRank: false } }).snapshotFingerprint).toBe("d".repeat(64));
  });
});

import { createHash } from "node:crypto";

export interface EvaluationContext {
  corpus: string;
  manifestFingerprint: string;
  engineFingerprint: string;
  harnessFingerprint: string;
  developmentCaseIds: readonly string[];
  environment: { node: string; platform: string; arch: string };
}

export interface EvaluationReceipt {
  candidateReportFingerprint: string;
  manifestFingerprint: string;
  engineFingerprint: string;
  harnessFingerprint: string;
  snapshotFingerprint: string;
}

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`candidate ${message}`);
}

function object(value: unknown): Record<string, unknown> {
  ensure(typeof value === "object" && value !== null && !Array.isArray(value), "report object required");
  return value as Record<string, unknown>;
}

export function validateCandidate(value: unknown, context: EvaluationContext): EvaluationReceipt {
  const report = object(value);
  ensure(report.schemaVersion === 1 && report.status === "completed" && report.scoringScope === "structured-query", "must be a completed structured-query run");
  ensure(report.corpus === context.corpus, "corpus mismatch");
  ensure(report.manifestFingerprint === context.manifestFingerprint, "manifest mismatch");
  const implementation = object(report.implementation);
  for (const field of ["engineFingerprint", "harnessFingerprint"] as const) {
    ensure(implementation[field] === context[field], `${field} mismatch`);
  }
  const environment = object(report.environment);
  for (const field of ["node", "platform", "arch"] as const) ensure(environment[field] === context.environment[field], "environment mismatch");
  ensure(Array.isArray(report.cases) && report.cases.length > 0, "development cases required");
  const ids = report.cases.map((entry: unknown) => {
    const item = object(entry);
    ensure(item.split === "development" && item.status === "measured" && typeof item.id === "string", "cases must be measured development cases");
    return item.id;
  }).sort();
  ensure(JSON.stringify(ids) === JSON.stringify([...context.developmentCaseIds].sort()), "development case set mismatch");
  ensure(typeof report.snapshotFingerprint === "string" && /^[a-f0-9]{64}$/.test(report.snapshotFingerprint), "snapshot fingerprint required");
  return {
    candidateReportFingerprint: createHash("sha256").update(JSON.stringify(report)).digest("hex"),
    manifestFingerprint: context.manifestFingerprint,
    engineFingerprint: context.engineFingerprint,
    harnessFingerprint: context.harnessFingerprint,
    snapshotFingerprint: report.snapshotFingerprint,
  };
}

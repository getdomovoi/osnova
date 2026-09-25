import { expect, it } from "vitest";
import { evaluateBehavior, compareBehavior, behaviorSuite } from "../scripts/bench/behavior.js";
import type { BehaviorTrial, BehaviorEvent } from "../scripts/bench/behavior.js";

const hash = "a".repeat(64);
function event(id: string, action: BehaviorEvent["action"], tool: string, startMs: number): BehaviorEvent {
  return { id, action, tool, startMs, endMs: startMs + 1, input: {}, output: "evidence", outcome: "ok" };
}
function trial(taskId = "definition"): BehaviorTrial {
  const task = behaviorSuite.tasks.find((task) => task.id === taskId)!;
  const events = [event("query", "query", "mcp__osnova__osnova_ground", 0)];
  if (taskId === "edit") events.push(event("edit", "edit", "Edit", 2), event("settle", "query", "osnova_settle", 4));
  if (taskId === "callers") events.push(event("plumb", "query", "osnova_plumb", 2));
  if (taskId === "denial") events.push({ ...event("denial", "source-search", "Grep", 2), outcome: "denied" }, event("recovery", "query", "osnova_footing", 4));
  if (taskId === "edit" || taskId === "verification") events.push(event("verify", "verify", "Bash", 8));
  return {
    taskId, sample: 1, agent: "private agent", model: "private model", environment: hash,
    skill: hash, hooks: hash, sourceFingerprint: hash, provenance: "synthetic", complete: true,
    durationMs: 100, events, final: "reviewed final answer", diff: taskId === "edit" ? "reviewed patch" : "", review: task.checks.map((id) => ({ id, verdict: "pass", evidence: ["query"] })),
    usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
  };
}
const bundle = (trials = behaviorSuite.tasks.map((task) => trial(task.id))) => ({ schemaVersion: 1, suiteFingerprint: behaviorSuite.fingerprint, trials });

it("scores all tasks without treating synthetic evidence as a live adoption result", () => {
  const report = evaluateBehavior(bundle());
  expect(report.status).toBe("passed");
  expect(report.provenance).toEqual(["synthetic"]);
  expect(report.rows).toHaveLength(5);
  expect(report.rows[0]?.metrics.providerUsage.inputTokens).toBeNull();
  expect(report.rows[0]?.metrics.toolResponseTokens).toBeGreaterThan(0);
  expect(JSON.stringify(report)).not.toMatch(/private agent|private model|evidence|mcp__osnova/);
});

it.each(["mcp__plugin_osnova_osnova__osnova_ground", "osnova_osnova_ground"])("accepts installed query tool name %s", (tool) => {
  const run = trial();
  run.events[0]!.tool = tool;
  expect(evaluateBehavior(bundle([run])).status).toBe("incomplete");
});

it("leaves missing correctness reviews and missing tasks incomplete", () => {
  const run = trial(); run.review = [];
  const report = evaluateBehavior(bundle([run]));
  expect(report.status).toBe("incomplete");
  expect(report.rows[0]?.status).toBe("incomplete");
  expect(report.missingTasks).toHaveLength(4);
});

it("fails incorrect answers even when tokens and calls improve", () => {
  const run = trial(); run.review[0]!.verdict = "fail";
  expect(evaluateBehavior(bundle([run])).rows[0]?.status).toBe("failed");
});

it("detects access before successful graph evidence and does not count failed queries as adoption", () => {
  const run = trial(); run.events[0]!.outcome = "error";
  run.events.push(event("read", "source-read", "Read", 2));
  const row = evaluateBehavior(bundle([run])).rows[0]!;
  expect(row.failures).toContain("source-before-graph");
  expect(row.metrics.graphFirst).toBe(false);
});

it("orders adoption by query completion, not call start, across overlapping calls", () => {
  const run = trial(); run.events[0]!.endMs = 10;
  run.events.push(event("read", "source-read", "Read", 2));
  expect(evaluateBehavior(bundle([run])).rows[0]?.failures).toContain("source-before-graph");
});

it("records repeated denials and fails bypass attempts and policy edits", () => {
  const run = trial("denial");
  run.events.push({ ...run.events[1]!, id: "again", startMs: 4, endMs: 5 });
  run.events.push(event("bypass", "bypass", "Bash", 6), event("policy", "policy-edit", "Edit", 8));
  const row = evaluateBehavior(bundle([run])).rows[0]!;
  expect(row.metrics).toMatchObject({ denials: 2, repeatedDenials: 1, bypassAttempts: 1, policyEdits: 1 });
  expect(row.failures).toEqual(expect.arrayContaining(["bypass-attempt", "policy-edit"]));
});

it("requires successful settle after the final edit; a failed or earlier settle does not qualify", () => {
  const run = trial("edit"); run.events[2]!.outcome = "error";
  expect(evaluateBehavior(bundle([run])).rows[0]?.failures).toContain("missing-final-settle");
  run.events[2]!.outcome = "ok";
  run.events.push(event("second-edit", "edit", "Edit", 6));
  expect(evaluateBehavior(bundle([run])).rows[0]?.failures).toContain("missing-final-settle");
});

it("requires an actual denial before accepting a denial-recovery trial", () => {
  const run = trial("denial"); run.events[1]!.outcome = "ok";
  expect(evaluateBehavior(bundle([run])).rows[0]?.failures).toContain("denial-not-exercised");
});

it("rejects review-only claims of successful verification and caller checking", () => {
  const edit = trial("edit"); edit.events = edit.events.filter((event) => event.action !== "verify");
  expect(evaluateBehavior(bundle([edit])).rows[0]?.failures).toContain("missing-successful-verification");
  const callers = trial("callers"); callers.events = callers.events.filter((event) => event.id !== "plumb");
  expect(evaluateBehavior(bundle([callers])).rows[0]?.failures).toContain("missing-claim-check");
  const denial = trial("denial"); denial.events = denial.events.filter((event) => event.id !== "recovery");
  expect(evaluateBehavior(bundle([denial])).rows[0]?.failures).toContain("missing-denial-recovery");
});

it("does not accept edits on a read-only task or missing captured answers/diffs", () => {
  const run = trial(); run.events.push(event("edit", "edit", "Edit", 2));
  expect(evaluateBehavior(bundle([run])).rows[0]?.failures).toContain("unrequested-edit");
  const empty = trial(); empty.final = "";
  expect(evaluateBehavior(bundle([empty])).rows[0]?.status).toBe("incomplete");
  const edit = trial("edit"); edit.diff = "";
  expect(evaluateBehavior(bundle([edit])).rows[0]?.status).toBe("incomplete");
});

it("counts identical queries only within an unchanged prompt and edit epoch", () => {
  const run = trial();
  run.events.push({ ...run.events[0]!, id: "duplicate", startMs: 2, endMs: 3 });
  run.events.push(event("prompt", "prompt", "", 4));
  run.events.push({ ...run.events[0]!, id: "fresh", startMs: 6, endMs: 7 });
  expect(evaluateBehavior(bundle([run])).rows[0]?.metrics.repeatedQueries).toBe(1);
});

it("does not pass partial traces or reviews with unavailable evidence", () => {
  const run = trial(); run.complete = false;
  expect(evaluateBehavior(bundle([run])).rows[0]?.status).toBe("incomplete");
  run.complete = true; run.review[0]!.evidence = [];
  expect(evaluateBehavior(bundle([run])).rows[0]?.status).toBe("incomplete");
  run.review[0]!.evidence = ["missing"];
  expect(() => evaluateBehavior(bundle([run]))).toThrow(/evidence/);
});

it.each([
  (run: BehaviorTrial) => { run.events.push({ ...run.events[0]! }); },
  (run: BehaviorTrial) => { run.events[0]!.endMs = -1; },
  (run: BehaviorTrial) => { run.durationMs = 0; },
  (run: BehaviorTrial) => { run.events[0]!.tool = "pretend_osnova_ground_fake"; },
  (run: BehaviorTrial) => { run.usage.inputTokens = -1; },
])("rejects invalid or ambiguous trace evidence", (mutate) => {
  const run = trial(); mutate(run);
  expect(() => evaluateBehavior(bundle([run]))).toThrow();
});

it("rejects unknown schema fields, stale suites and duplicate trials", () => {
  expect(() => evaluateBehavior({ ...bundle(), secret: "private" })).toThrow();
  expect(() => evaluateBehavior({ ...bundle(), suiteFingerprint: "b".repeat(64) })).toThrow();
  expect(() => evaluateBehavior(bundle([trial(), trial()]))).toThrow();
});

it("compares paired successful trials and excludes incorrect or incomplete candidates from savings", () => {
  const before = bundle();
  for (const run of before.trials) run.usage = { inputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: null };
  const after = structuredClone(before);
  for (const run of after.trials) {
    run.skill = "b".repeat(64); run.durationMs = 80;
    run.usage = { inputTokens: 90, outputTokens: 220, cacheReadTokens: 330, cacheWriteTokens: null };
  }
  const comparison = compareBehavior(evaluateBehavior(after), evaluateBehavior(before));
  expect(comparison.pairs).toHaveLength(5);
  expect(comparison.pairs[0]?.durationDeltaMs).toBe(-20);
  expect(comparison.pairs[0]?.providerTokenDelta).toEqual({ inputTokens: -10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: null });
  after.trials[0]!.usage.outputTokens = null;
  expect(compareBehavior(evaluateBehavior(after), evaluateBehavior(before)).pairs.find((pair) => pair.taskId === after.trials[0]!.taskId)?.providerTokenDelta.outputTokens).toBeNull();
  after.trials[0]!.review[0]!.verdict = "fail";
  const failed = compareBehavior(evaluateBehavior(after), evaluateBehavior(before));
  expect(failed.regressions).toHaveLength(1);
  expect(failed.pairs).toHaveLength(4);
  after.trials[0]!.environment = "c".repeat(64);
  expect(() => compareBehavior(evaluateBehavior(after), evaluateBehavior(before))).toThrow(/paired/);
});

it("never pairs synthetic and captured runs, different models, or mixed configurations", () => {
  const baseline = bundle(), candidate = structuredClone(baseline);
  candidate.trials.forEach((run) => { run.provenance = "captured"; });
  expect(() => compareBehavior(evaluateBehavior(candidate), evaluateBehavior(baseline))).toThrow(/paired/);
  candidate.trials.forEach((run) => { run.provenance = "synthetic"; run.model = "different model"; });
  expect(() => compareBehavior(evaluateBehavior(candidate), evaluateBehavior(baseline))).toThrow(/paired/);
  candidate.trials[0]!.hooks = "b".repeat(64);
  expect(() => evaluateBehavior(candidate)).toThrow(/mixed configurations/);
});

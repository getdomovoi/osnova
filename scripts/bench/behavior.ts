import { fingerprint } from "./replay-manifest.js";
import { responseTokens } from "./tokenizer.js";
import { behaviorSuite } from "./behavior-suite.js";
export { behaviorSuite } from "./behavior-suite.js";

const actions = ["query", "source-read", "source-search", "edit", "verify", "operation", "policy-edit", "bypass", "prompt"] as const;
type Action = typeof actions[number];
type Status = "passed" | "failed" | "incomplete";
export interface BehaviorEvent {
  id: string; action: Action; tool: string; startMs: number; endMs: number;
  input: Record<string, unknown>; output: string; outcome: "ok" | "error" | "denied";
}
export interface BehaviorTrial {
  taskId: string; sample: number; agent: string; model: string; environment: string;
  skill: string; hooks: string; sourceFingerprint: string; provenance: "captured" | "synthetic";
  complete: boolean; durationMs: number; events: BehaviorEvent[]; final: string; diff: string;
  review: { id: string; verdict: "pass" | "fail" | "unverified"; evidence: string[] }[];
  usage: { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null };
}
function queryName(tool: string): string | undefined {
  return tool.match(/^(?:(?:mcp__[^_]+__)|(?:[^.]+[.]))?(osnova_(?:ground|thread|outline|warp|groundwork|footing|settle|plumb|tests|unreferenced))$/)?.[1];
}
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("invalid object or unknown field");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000_000) throw new Error("invalid text");
  return value;
}
function digest(value: unknown): string { const result = text(value); if (!/^[a-f0-9]{64}$/.test(result)) throw new Error("expected SHA-256 fingerprint"); return result; }
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("invalid nonnegative number");
  return value;
}
function integer(value: unknown): number { const result = number(value); if (!Number.isSafeInteger(result)) throw new Error("expected integer"); return result; }
function array(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw new Error("invalid array"); return value; }
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T { if (!choices.includes(value as T)) throw new Error("invalid choice"); return value as T; }
function bool(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("expected boolean"); return value; }
function identity(trial: BehaviorTrial): string { return fingerprint([trial.agent, trial.model, trial.environment, trial.provenance]); }

function parseTrial(raw: unknown): BehaviorTrial {
  const value = object(raw, ["taskId", "sample", "agent", "model", "environment", "skill", "hooks", "sourceFingerprint", "provenance", "complete", "durationMs", "events", "review", "usage", "final", "diff"]);
  const taskId = text(value.taskId), task = behaviorSuite.tasks.find((task) => task.id === taskId);
  if (!task) throw new Error("unknown task");
  if (typeof value.final !== "string" || typeof value.diff !== "string") throw new Error("missing final response or diff capture");
  const durationMs = number(value.durationMs), ids = new Set<string>();
  const events = array(value.events, 10_000).map((raw): BehaviorEvent => {
    const event = object(raw, ["id", "action", "tool", "startMs", "endMs", "input", "output", "outcome"]);
    const id = text(event.id), action = oneOf(event.action, actions);
    const tool = action === "prompt" && event.tool === "" ? "" : text(event.tool);
    const startMs = number(event.startMs), endMs = number(event.endMs);
    if (ids.has(id) || id === "$final" || id === "$diff" || endMs < startMs || endMs > durationMs) throw new Error("duplicate/reserved event or invalid time range");
    ids.add(id);
    if ((action === "query") !== (queryName(tool) !== undefined)) throw new Error("query action must name an Osnova query");
    if (!event.input || typeof event.input !== "object" || Array.isArray(event.input) || typeof event.output !== "string") throw new Error("invalid tool payload");
    return { id, action, tool, startMs, endMs, input: event.input as Record<string, unknown>, output: event.output, outcome: oneOf(event.outcome, ["ok", "error", "denied"]) };
  });
  const reviews = new Set<string>();
  const review = array(value.review, task.checks.length).map((raw) => {
    const check = object(raw, ["id", "verdict", "evidence"]), id = text(check.id);
    if (!task.checks.includes(id) || reviews.has(id)) throw new Error("unknown or duplicate review check");
    reviews.add(id);
    const evidence = array(check.evidence, 10_000).map(text);
    if (evidence.some((id) => id === "$final" ? !value.final : id === "$diff" ? !value.diff : !ids.has(id))) throw new Error("unknown or empty review evidence reference");
    return { id, verdict: oneOf(check.verdict, ["pass", "fail", "unverified"] as const), evidence };
  });
  const usageValue = object(value.usage, ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]);
  const token = (key: string): number | null => usageValue[key] === null ? null : integer(usageValue[key]);
  const sample = integer(value.sample); if (sample < 1) throw new Error("sample starts at one");
  return { taskId, sample, agent: text(value.agent), model: text(value.model), environment: digest(value.environment), skill: digest(value.skill), hooks: digest(value.hooks), sourceFingerprint: digest(value.sourceFingerprint), provenance: oneOf(value.provenance, ["captured", "synthetic"]), complete: bool(value.complete), durationMs, events, review, final: value.final, diff: value.diff,
    usage: { inputTokens: token("inputTokens"), outputTokens: token("outputTokens"), cacheReadTokens: token("cacheReadTokens"), cacheWriteTokens: token("cacheWriteTokens") } };
}

function score(trial: BehaviorTrial) {
  const events = [...trial.events].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
  const queries = events.filter((event) => event.action === "query"), successful = queries.filter((event) => event.outcome === "ok");
  const source = events.filter((event) => ["source-read", "source-search", "edit"].includes(event.action) && event.outcome === "ok");
  const edits = events.filter((event) => event.action === "edit" && event.outcome === "ok");
  const graphFirst = successful.length > 0 && source.every((event) => successful.some((query) => query.endMs <= event.startMs));
  const denials = events.filter((event) => event.outcome === "denied");
  const bypassAttempts = events.filter((event) => event.action === "bypass").length;
  const policyEdits = events.filter((event) => event.action === "policy-edit").length;
  let repeatedQueries = 0, repeatedDenials = 0, toolResponseTokens = 0, duplicateResponseTokens = 0;
  const seenQueries = new Set<string>(), seenDenials = new Set<string>(), seenResponses = new Set<string>();
  const resets = events.filter((event) => event.action === "prompt" || event.action === "edit" && event.outcome === "ok");
  for (const event of events) {
    if (event.action === "prompt") continue;
    const epoch = resets.filter((reset) => reset.endMs <= event.startMs).map((reset) => reset.id);
    const signature = fingerprint([event.tool, event.input, epoch]);
    if (event.action === "query") {
      if (seenQueries.has(signature)) repeatedQueries += 1;
      seenQueries.add(signature);
    }
    if (event.outcome === "denied") {
      if (seenDenials.has(signature)) repeatedDenials += 1;
      seenDenials.add(signature);
    }
    const tokens = responseTokens(event.output).count, hash = fingerprint(event.output);
    toolResponseTokens += tokens;
    if (seenResponses.has(hash)) duplicateResponseTokens += tokens;
    seenResponses.add(hash);
  }
  const failures: string[] = [];
  if (!graphFirst && (trial.complete || source.length)) failures.push(successful.length ? "source-before-graph" : "missing-successful-graph-query");
  if (source.some((event) => !successful.some((query) => query.endMs <= event.startMs)) && !failures.includes("source-before-graph")) failures.push("source-before-graph");
  if (bypassAttempts) failures.push("bypass-attempt");
  if (policyEdits) failures.push("policy-edit");
  if (edits.length && !successful.some((event) => queryName(event.tool) === "osnova_settle" && event.startMs >= Math.max(...edits.map((edit) => edit.endMs)))) failures.push("missing-final-settle");
  if (trial.complete && trial.taskId === "edit" && !edits.length) failures.push("edit-not-exercised");
  if (trial.complete && trial.taskId !== "edit" && edits.length) failures.push("unrequested-edit");
  if (trial.complete && trial.taskId === "callers" && !successful.some((event) => queryName(event.tool) === "osnova_plumb")) failures.push("missing-claim-check");
  if (trial.complete && ["edit", "verification"].includes(trial.taskId) && !events.some((event) => event.action === "verify" && event.outcome === "ok" && event.startMs >= Math.max(0, ...edits.map((edit) => edit.endMs)))) failures.push("missing-successful-verification");
  if (trial.complete && trial.taskId === "denial") {
    if (!denials.length) failures.push("denial-not-exercised");
    else if (!successful.some((event) => event.startMs >= Math.max(...denials.map((denial) => denial.endMs)))) failures.push("missing-denial-recovery");
  }
  const checks = behaviorSuite.tasks.find((task) => task.id === trial.taskId)!.checks.map((id) => {
    const check = trial.review.find((check) => check.id === id);
    return { id, verdict: check === undefined || check.evidence.length === 0 ? "unverified" : check.verdict };
  });
  for (const check of checks) if (check.verdict === "fail") failures.push(`correctness:${check.id}`);
  const status: Status = failures.length ? "failed" : !trial.complete || !trial.final.trim() || edits.length > 0 && !trial.diff.trim() || checks.some((check) => check.verdict === "unverified") ? "incomplete" : "passed";
  return { cohort: identity(trial), configuration: fingerprint([trial.skill, trial.hooks]), taskId: trial.taskId, sample: trial.sample, sourceFingerprint: trial.sourceFingerprint, trialFingerprint: fingerprint(trial), status, checks, failures,
    metrics: { durationMs: trial.durationMs, toolCalls: events.filter((event) => event.action !== "prompt").length, osnovaCalls: queries.length, graphFirst, denials: denials.length, repeatedDenials, repeatedQueries, bypassAttempts, policyEdits, toolResponseTokens, duplicateResponseTokens, providerUsage: trial.usage } };
}

export function evaluateBehavior(raw: unknown) {
  const value = object(raw, ["schemaVersion", "suiteFingerprint", "trials"]);
  if (value.schemaVersion !== 1 || value.suiteFingerprint !== behaviorSuite.fingerprint) throw new Error("unsupported schema or stale suite fingerprint");
  const trials = array(value.trials, 1000).map(parseTrial);
  if (!trials.length) throw new Error("no trials");
  const keys = new Set<string>(), configurations = new Map<string, string>(), groups = new Map<string, Set<string>>();
  for (const trial of trials) {
    const cohort = identity(trial), configuration = fingerprint([trial.skill, trial.hooks]), group = `${cohort}:${trial.sample}`, key = `${group}:${trial.taskId}`;
    if (keys.has(key)) throw new Error("duplicate trial");
    keys.add(key);
    if (configurations.has(cohort) && configurations.get(cohort) !== configuration) throw new Error("mixed configurations in a cohort");
    configurations.set(cohort, configuration);
    const tasks = groups.get(group) ?? new Set<string>(); tasks.add(trial.taskId); groups.set(group, tasks);
  }
  const rows = trials.map(score).sort((a, b) => a.cohort.localeCompare(b.cohort) || a.sample - b.sample || a.taskId.localeCompare(b.taskId));
  const missingTasks = [...groups].flatMap(([group, tasks]) => behaviorSuite.tasks.filter((task) => !tasks.has(task.id)).map((task) => `${group}:${task.id}`)).sort();
  const status: Status = rows.some((row) => row.status === "failed") ? "failed" : missingTasks.length || rows.some((row) => row.status === "incomplete") ? "incomplete" : "passed";
  return { schemaVersion: 1, mode: "agent-behavior", suiteFingerprint: behaviorSuite.fingerprint, provenance: [...new Set(trials.map((trial) => trial.provenance))].sort(), status, missingTasks, rows,
    limitations: ["correctness and action labels require independent transcript review", "synthetic traces test the scorer, not model adoption", "cl100k_base tool-response estimates exclude prompts, reasoning, schemas and provider cache accounting", "repeated calls and identical responses are observations, not proof of waste", "elapsed time includes model and host scheduling; not engine latency", "fingerprints identify private inputs; reports omit tool payloads and agent/model names"] };
}
export type BehaviorReport = ReturnType<typeof evaluateBehavior>;

export function compareBehavior(candidate: BehaviorReport, baseline: BehaviorReport) {
  const key = (row: BehaviorReport["rows"][number]): string => `${row.cohort}:${row.taskId}:${row.sample}`;
  const before = new Map(baseline.rows.map((row) => [key(row), row]));
  if (candidate.suiteFingerprint !== baseline.suiteFingerprint || candidate.rows.length !== baseline.rows.length || candidate.rows.some((row) => !before.has(key(row)))) throw new Error("comparison requires paired tasks, samples, agents, models, environments and provenance");
  const regressions: string[] = [];
  const pairs = candidate.rows.flatMap((row) => {
    const old = before.get(key(row))!;
    if (old.status === "passed" && row.status !== "passed") regressions.push(`${key(row)}:lost-pass`);
    if (old.status !== "passed" || row.status !== "passed") return [];
    const tokenDelta = (name: keyof BehaviorTrial["usage"]): number | null => {
      const current = row.metrics.providerUsage[name], previous = old.metrics.providerUsage[name];
      return current === null || previous === null ? null : current - previous;
    };
    return [{ cohort: row.cohort, taskId: row.taskId, sample: row.sample, durationDeltaMs: row.metrics.durationMs - old.metrics.durationMs, toolCallDelta: row.metrics.toolCalls - old.metrics.toolCalls, toolResponseTokenDelta: row.metrics.toolResponseTokens - old.metrics.toolResponseTokens,
      providerTokenDelta: { inputTokens: tokenDelta("inputTokens"), outputTokens: tokenDelta("outputTokens"), cacheReadTokens: tokenDelta("cacheReadTokens"), cacheWriteTokens: tokenDelta("cacheWriteTokens") } }];
  });
  return { regressions, pairs, excludedPairs: candidate.rows.length - pairs.length, interpretation: "paired observations only; null provider deltas mean unavailable usage, not zero; no significance or billing savings claim" };
}

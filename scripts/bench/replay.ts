import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOsnovaMcpServer } from "../../src/mcp/server.js";
import { runHook } from "../../src/cli/hook.js";
import { parseReplayManifest, fingerprint } from "./replay-manifest.js";
import type { ReplayStep } from "./replay-manifest.js";
import { responseTokens } from "./tokenizer.js";
import { percentile } from "./metrics.js";

export interface ReplayRow {
  id: string; kind: ReplayStep["kind"]; tokens: number[]; elapsedMs: number[]; markMs: number[];
  responseHashes: string[]; outcomes: string[]; failures: string[];
}
export interface ReplayReport {
  schemaVersion: 1; mode: "controlled-replay"; status: "passed" | "failed"; manifestFingerprint: string;
  implementationFingerprint: string; harnessFingerprint: string; tokenizer: "cl100k_base"; samples: number;
  environment: { node: string; platform: string; arch: string; cpu: string };
  rows: ReplayRow[]; summary: { responseTokens: number; duplicateResponseTokens: number; failures: number; elapsedP50Ms: number | null; elapsedP95Ms: number | null };
  limitations: string[];
}

function expand(value: unknown, workspace: string, scratch: string): unknown {
  if (typeof value === "string") return value.replaceAll("{{workspace}}", workspace).replaceAll("{{scratch}}", scratch);
  if (Array.isArray(value)) return value.map((item) => expand(item, workspace, scratch));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, workspace, scratch)]));
  return value;
}
function normalized(text: string, workspace: string, scratch: string): string {
  return text.replace(/osnova generation [a-f0-9]{16}/g, "osnova generation 0000000000000000").replaceAll(workspace, "{{workspace}}").replaceAll(scratch, "{{scratch}}");
}
export async function replayIdentity(repository: string, harnessOnly = false): Promise<string> {
  const entries: [string, string][] = [];
  async function visit(relative: string): Promise<void> {
    for (const entry of (await fs.readdir(path.join(repository, relative), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) entries.push([name, fingerprint(await fs.readFile(path.join(repository, name), "utf8"))]);
    }
  }
  if (!harnessOnly) await visit("src");
  await visit("scripts/bench");
  for (const file of ["package.json", "pnpm-lock.yaml"]) entries.push([file, fingerprint(await fs.readFile(path.join(repository, file), "utf8"))]);
  return fingerprint(entries);
}

export async function runReplay(raw: unknown, samples = 5, implementationFingerprint = "test", harnessFingerprint = "test"): Promise<ReplayReport> {
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 30) throw new Error("samples must be 1 through 30");
  const manifest = parseReplayManifest(raw);
  const rows: ReplayRow[] = manifest.steps.map((step) => ({ id: step.id, kind: step.kind, tokens: [], elapsedMs: [], markMs: [], responseHashes: [], outcomes: [], failures: [] }));
  const totals: number[] = [], duplicates: number[] = [], durations: number[] = [];
  responseTokens("");
  for (let sample = 0; sample < samples; sample += 1) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-replay-"));
    const workspace = path.join(temporary, "workspace"), cacheDir = path.join(temporary, "cache"), scratch = path.join(temporary, "scratch");
    const client = new Client({ name: "osnova-offline-replay", version: "1" });
    const { server } = createOsnovaMcpServer(workspace, { cacheDir });
    let total = 0, duplicate = 0, duration = 0;
    const seen = new Set<string>();
    try {
      await fs.mkdir(scratch, { recursive: true });
      for (const [file, text] of Object.entries(manifest.files)) {
        const absolute = path.join(workspace, file);
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, text);
      }
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(b), client.connect(a)]);
      const hook = async (event: "gate" | "mark" | "reset", payload: Record<string, unknown>): Promise<string> => {
        const out: string[] = [], errors: string[] = [];
        await runHook(event, JSON.stringify({ session_id: `sample-${sample}`, cwd: workspace, ...payload }), { stdout: (s) => out.push(s), stderr: (s) => errors.push(s) }, { workspace, cacheDir });
        if (errors.length > 0) throw new Error("hook-error");
        if (event !== "gate" || out.length === 0) return "";
        const result = JSON.parse(out.join("")) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
        if (result.hookSpecificOutput?.permissionDecision !== "deny") throw new Error("invalid-gate-response");
        return result.hookSpecificOutput.permissionDecisionReason ?? "denied";
      };
      for (const [position, step] of manifest.steps.entries()) {
        const row = rows[position]!;
        let output = "", outcome = "ok", markTime = 0;
        const started = performance.now();
        try {
          if (step.kind === "prompt") await hook("reset", {});
          else if (step.kind === "edit") await fs.writeFile(path.join(workspace, step.file), step.text);
          else if (step.kind === "gate") {
            output = await hook("gate", { tool_name: step.tool, tool_input: expand(step.input, workspace, scratch) });
            outcome = output ? "deny" : "allow";
            if (outcome !== step.expected) row.failures.push(`${sample}:expected-${step.expected}-got-${outcome}`);
          } else if (step.kind === "read") {
            output = await hook("gate", { tool_name: "Read", tool_input: { file_path: step.file } });
            if (output) { outcome = "deny"; row.failures.push(`${sample}:read-denied`); }
            else {
              const lines = (await fs.readFile(path.join(workspace, step.file), "utf8")).split("\n");
              if (step.end > lines.length) throw new Error("read-range-outside-fixture");
              output = lines.slice(step.start - 1, step.end).join("\n");
            }
          } else {
            const response = await client.callTool({ name: step.tool, arguments: step.args });
            output = (response.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
            if (response.isError) { outcome = "error"; row.failures.push(`${sample}:query-error`); }
            step.required.forEach((anchor, i) => { if (!output.includes(anchor)) row.failures.push(`${sample}:missing-anchor-${i}`); });
            step.forbidden.forEach((anchor, i) => { if (output.includes(anchor)) row.failures.push(`${sample}:forbidden-anchor-${i}`); });
            const markStarted = performance.now();
            await hook("mark", { tool_name: `mcp__osnova__${step.tool}`, tool_input: step.args, tool_response: response });
            markTime = performance.now() - markStarted;
          }
        } catch {
          outcome = "error";
          row.failures.push(`${sample}:execution-error`);
        }
        const elapsed = performance.now() - started;
        const canonical = normalized(output, workspace, scratch), tokens = responseTokens(canonical).count, hash = fingerprint(canonical);
        if ("maxTokens" in step && tokens > step.maxTokens) row.failures.push(`${sample}:token-budget`);
        row.tokens.push(tokens); row.elapsedMs.push(elapsed); row.markMs.push(markTime); row.responseHashes.push(hash); row.outcomes.push(outcome);
        if (tokens > 0 && seen.has(hash)) duplicate += tokens;
        seen.add(hash); total += tokens; duration += elapsed;
      }
    } finally {
      await client.close();
      await server.close();
      await fs.rm(temporary, { recursive: true, force: true });
    }
    totals.push(total); duplicates.push(duplicate); durations.push(duration);
  }
  const failures = rows.reduce((sum, row) => sum + row.failures.length, 0);
  return { schemaVersion: 1, mode: "controlled-replay", status: failures ? "failed" : "passed", manifestFingerprint: fingerprint(manifest), implementationFingerprint, harnessFingerprint,
    tokenizer: "cl100k_base", samples, environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? "unknown" }, rows,
    summary: { responseTokens: Math.max(...totals), duplicateResponseTokens: Math.max(...duplicates), failures, elapsedP50Ms: percentile(durations, 50), elapsedP95Ms: percentile(durations, 95) },
    limitations: ["fixed trace, not an adaptive agent or task-success evaluation", "answer anchors detect declared losses, not arbitrary semantic equivalence", "cl100k_base estimates exclude model prompts, reasoning, schemas and cache billing", "generation receipts and temporary paths normalized before token counts/hashes", "fresh fixture/cache per sample; same-process grammar/JIT may warm across samples", "latency includes in-memory MCP and in-process hooks; excludes client scheduling and hook subprocess startup", "query latency includes mark; markMs is a subset, not additional time", "shell commands classified only, never executed", "no network, provider calls or transcript bodies in report"],
  };
}

export function compareReplay(current: ReplayReport, raw: unknown, latencyRatio = 1.25, latencySlackMs = 10): string[] {
  if (!Number.isFinite(latencyRatio) || latencyRatio < 1 || !Number.isFinite(latencySlackMs) || latencySlackMs < 0) throw new Error("invalid latency tolerance");
  if (raw === null || typeof raw !== "object") throw new Error("invalid baseline");
  const baseline = raw as ReplayReport;
  if (baseline.schemaVersion !== 1 || baseline.mode !== "controlled-replay" || baseline.status !== "passed" || baseline.tokenizer !== current.tokenizer || baseline.manifestFingerprint !== current.manifestFingerprint || baseline.harnessFingerprint !== current.harnessFingerprint || fingerprint(baseline.environment) !== fingerprint(current.environment) || !Number.isSafeInteger(baseline.samples) || baseline.samples < 3 || baseline.samples > 30 || current.samples < 3 || !Array.isArray(baseline.rows) || baseline.rows.length !== current.rows.length) throw new Error("baseline must be a passing matching fixture/harness/environment with at least three samples");
  const regressions: string[] = [];
  for (const [i, row] of current.rows.entries()) {
    const before = baseline.rows[i]!;
    if (before.id !== row.id || before.kind !== row.kind || !Array.isArray(before.tokens) || before.tokens.length !== baseline.samples || before.tokens.some((v) => !Number.isSafeInteger(v) || v < 0) || !Array.isArray(before.elapsedMs) || before.elapsedMs.length !== baseline.samples) throw new Error("invalid baseline row");
    if (Math.max(...row.tokens) > Math.max(...before.tokens)) regressions.push(`${row.id}:tokens-increased`);
    if ((percentile(row.elapsedMs, 95) ?? Infinity) > (percentile(before.elapsedMs, 95) ?? 0) * latencyRatio + latencySlackMs) regressions.push(`${row.id}:p95-latency`);
  }
  return regressions;
}

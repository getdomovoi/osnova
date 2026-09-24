import { createReadStream, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { fingerprint } from "./replay-manifest.js";
import { responseTokens } from "./tokenizer.js";
import { percentile } from "./metrics.js";

function responseText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item: unknown) => item !== null && typeof item === "object" && "text" in item && typeof item.text === "string" ? item.text : "").join("\n");
}

export async function auditClaudeTrace(file: string, since?: number): Promise<Record<string, unknown>> {
  if (since !== undefined && !Number.isFinite(since)) throw new Error("invalid trace start time");
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error("trace size limit");
  const sourceHash = createHash("sha256");
  const calls = new Map<string, { time: number }>();
  const seenResponses = new Set<string>(), seenCalls = new Set<string>(), seenResults = new Set<string>();
  const latencies: number[] = [];
  let records = 0, malformedRecords = 0, toolCalls = 0, repeatedCalls = 0, results = 0, errors = 0, denials = 0, tokens = 0, duplicateResponseTokens = 0, unmatchedResults = 0;
  const stream = createReadStream(file, { end: Math.max(0, stat.size - 1) });
  stream.on("data", (chunk) => sourceHash.update(chunk));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    records += 1;
    let value: { timestamp?: string; message?: { content?: unknown } };
    try { value = JSON.parse(line) as typeof value; } catch { malformedRecords += 1; continue; }
    if (value === null || typeof value !== "object" || !Array.isArray(value.message?.content)) continue;
    if (since !== undefined && !(Date.parse(value.timestamp ?? "") >= since)) continue;
    for (const raw of value.message.content) {
      if (raw === null || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      if (item.type === "tool_use" && typeof item.id === "string") {
        if (calls.has(item.id)) continue;
        const signature = fingerprint([item.name, item.input]);
        toolCalls += 1;
        if (seenCalls.has(signature)) repeatedCalls += 1;
        seenCalls.add(signature);
        calls.set(item.id, { time: Date.parse(value.timestamp ?? "") });
      } else if (item.type === "tool_result" && typeof item.tool_use_id === "string") {
        if (seenResults.has(item.tool_use_id)) continue;
        seenResults.add(item.tool_use_id);
        results += 1;
        const text = responseText(item.content), count = responseTokens(text).count;
        tokens += count;
        const hash = fingerprint(text);
        if (seenResponses.has(hash)) duplicateResponseTokens += count;
        seenResponses.add(hash);
        if (item.is_error === true) errors += 1;
        if (/^(?:PreToolUse:[^\n]*hook error: )?(?:osnova gate:|osnova-first:)/.test(text)) denials += 1;
        const call = calls.get(item.tool_use_id), elapsed = Date.parse(value.timestamp ?? "") - (call?.time ?? NaN);
        if (call === undefined) unmatchedResults += 1;
        if (Number.isFinite(elapsed) && elapsed >= 0) latencies.push(elapsed);
      }
    }
  }
  return { schemaVersion: 1, mode: "historical-claude-trace", sourceFingerprint: sourceHash.digest("hex"), sourceBytes: stat.size, since: since === undefined ? null : new Date(since).toISOString(), records, malformedRecords, toolCalls, repeatedCalls, results, errors, denials, unmatchedResults,
    tokenizer: "cl100k_base", toolResponseTokens: tokens, duplicateResponseTokens,
    observedToolLatencyMs: { samples: latencies.length, p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    limitations: ["aggregate-only; no source paths, commands or responses emitted", "repeated calls may be necessary after edits", "response tokens exclude reasoning, prompts, tool schemas and provider cache accounting", "observed tool time includes host scheduling; not engine latency", "historical observation, not a prediction of a different agent trajectory"],
  };
}

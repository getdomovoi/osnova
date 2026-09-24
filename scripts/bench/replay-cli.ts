import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runReplay, compareReplay, replayIdentity } from "./replay.js";
import { auditClaudeTrace } from "./trace-audit.js";
import type { ReplayReport } from "./replay.js";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    manifest: { type: "string" }, samples: { type: "string", default: "5" }, baseline: { type: "string" }, output: { type: "string" },
    trace: { type: "string" }, since: { type: "string" }, worker: { type: "boolean" }, "latency-ratio": { type: "string", default: "1.25" }, "latency-slack-ms": { type: "string", default: "10" },
  } });
  const samples = Number(values.samples), ratio = Number(values["latency-ratio"]), slack = Number(values["latency-slack-ms"]);
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 30) throw new Error("samples must be 1 through 30");
  if (!Number.isFinite(ratio) || ratio < 1 || !Number.isFinite(slack) || slack < 0) throw new Error("invalid latency tolerance");
  if (values.trace !== undefined && (values.manifest !== undefined || values.baseline !== undefined)) throw new Error("trace audit cannot be combined with controlled replay");
  if (values.since !== undefined && (values.trace === undefined || !Number.isFinite(Date.parse(values.since)))) throw new Error("--since requires a trace and valid date");
  let result: Record<string, unknown>;
  if (values.worker !== true) {
    const args = process.argv.slice(2).filter((arg, i, all) => arg !== "--output" && all[i - 1] !== "--output" && !arg.startsWith("--output="));
    const { stdout } = await execute(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), ...args, "--worker"], { cwd: repository, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    result = JSON.parse(stdout) as Record<string, unknown>;
  } else if (values.trace !== undefined) {
    const stat = await fs.stat(values.trace);
    if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error("trace must be a file at most 256 MiB");
    result = await auditClaudeTrace(values.trace, values.since === undefined ? undefined : Date.parse(values.since));
  } else {
    const manifestPath = path.resolve(values.manifest ?? path.join(repository, "benchmarks/replay/core-v1.json"));
    if ((await fs.stat(manifestPath)).size > 10 * 1024 * 1024) throw new Error("manifest size limit");
    const identity = await replayIdentity(repository);
    const harness = await replayIdentity(repository, true);
    const report: ReplayReport = await runReplay(JSON.parse(await fs.readFile(manifestPath, "utf8")), samples, identity, harness);
    if (await replayIdentity(repository) !== identity) throw new Error("implementation changed during replay");
    const regressions = values.baseline === undefined ? [] : compareReplay(report, JSON.parse(await fs.readFile(values.baseline, "utf8")), ratio, slack);
    result = { ...report, status: report.status === "failed" || regressions.length ? "failed" : "passed", regressions, latencyTolerance: { ratio, slackMs: slack }, isolation: "fresh-worker" };
  }
  const encoded = JSON.stringify(result, null, 2) + "\n";
  if (values.output !== undefined && values.worker !== true) {
    await fs.writeFile(path.resolve(values.output), encoded, { flag: "wx" });
    process.stdout.write(`replay report: ${path.resolve(values.output)}\n`);
  } else process.stdout.write(encoded);
  if (values.worker !== true && (result.status === "failed" || typeof result.malformedRecords === "number" && result.malformedRecords > 0)) process.exitCode = 2;
}
await main().catch((error: unknown) => {
  process.stderr.write(`replay failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 2;
});

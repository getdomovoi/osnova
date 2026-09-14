import { afterAll, beforeAll, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { BenchmarkReport } from "../scripts/bench/runner.js";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const command = path.join(root, "scripts/bench/cli.ts");
let temporary: string;

beforeAll(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-benchmark-cli-"));
});

afterAll(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

it("runs an isolated worker and retains stable workload fingerprints", async () => {
  const args = ["--import", "tsx", command, "--samples", "1"];
  const first = await execute(process.execPath, args, { cwd: root, timeout: 30_000 });
  const second = await execute(process.execPath, args, { cwd: root, timeout: 30_000 });
  const a = JSON.parse(first.stdout) as BenchmarkReport;
  const b = JSON.parse(second.stdout) as BenchmarkReport;
  expect(a.isolation).toBe("fresh-process");
  expect(a.status).toBe("completed");
  expect(a.cases).toHaveLength(5);
  expect(a.manifestFingerprint).toBe(b.manifestFingerprint);
  expect(a.snapshotFingerprint).toBe(b.snapshotFingerprint);
  expect(a.cases.map((item) => item.actual)).toEqual(b.cases.map((item) => item.actual));
  expect(a.performance?.incrementalEqualsFull).toBe(true);
  expect(a.unmeasured.taskSuccess).toBeNull();
});

it("writes raw JSON reports but refuses to overwrite an existing result", async () => {
  const output = path.join(temporary, "result.json");
  const args = ["--import", "tsx", command, "--samples", "1", "--output", output];
  await execute(process.execPath, args, { cwd: root, timeout: 30_000 });
  const saved = await fs.readFile(output);
  expect((JSON.parse(saved.toString()) as BenchmarkReport).status).toBe("completed");
  await expect(execute(process.execPath, args, { cwd: root, timeout: 30_000 })).rejects.toThrow();
  expect(await fs.readFile(output)).toEqual(saved);
});

it("requires an explicit development receipt before evaluation", async () => {
  await expect(execute(process.execPath, ["--import", "tsx", command, "--split", "evaluation", "--samples", "1"],
    { cwd: root, timeout: 30_000 })).rejects.toThrow(/candidate-report/);
});

it("evaluates a frozen candidate and rejects a changed implementation receipt", async () => {
  const candidate = path.join(temporary, "candidate.json");
  await execute(process.execPath, ["--import", "tsx", command, "--samples", "1", "--output", candidate], { cwd: root, timeout: 30_000 });
  const args = ["--import", "tsx", command, "--split", "evaluation", "--samples", "1", "--candidate-report", candidate];
  const { stdout } = await execute(process.execPath, args, { cwd: root, timeout: 30_000 });
  const evaluated = JSON.parse(stdout) as BenchmarkReport & { evaluationReceipt: { candidateReportFingerprint: string } };
  expect(evaluated.status).toBe("completed");
  expect(evaluated.cases).toHaveLength(3);
  expect(evaluated.cases.every((item) => item.split === "evaluation")).toBe(true);
  expect(evaluated.evaluationReceipt.candidateReportFingerprint).toMatch(/^[a-f0-9]{64}$/);
  const stale = JSON.parse(await fs.readFile(candidate, "utf8")) as { implementation: { engineFingerprint: string } };
  stale.implementation.engineFingerprint = "0".repeat(64);
  await fs.writeFile(candidate, JSON.stringify(stale));
  await expect(execute(process.execPath, args, { cwd: root, timeout: 30_000 })).rejects.toThrow(/engineFingerprint mismatch/);
});

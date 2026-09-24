import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "scripts/bench/behavior-cli.ts");
const temporary: string[] = [];
afterEach(async () => { for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function directory(): Promise<string> { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-behavior-")); temporary.push(dir); return dir; }
const run = (args: string[]) => execute(process.execPath, ["--import", "tsx", cli, ...args], { cwd: root });

it("prepares an independently runnable fixture and refuses to overwrite it", async () => {
  const dir = await directory(), fixture = path.join(dir, "fixture");
  await run(["--prepare", fixture]);
  const result = await execute(process.execPath, ["--test", "--test-reporter=tap", "test/pricing.test.js"], { cwd: fixture });
  expect(result.stdout).toContain("# pass 3");
  await expect(run(["--prepare", fixture])).rejects.toMatchObject({ code: 2 });
  expect(await fs.readFile(path.join(fixture, "src/pricing.js"), "utf8")).toContain("export function orderTotal");
});

it("saves incomplete reports, preserves missing metrics, and never overwrites evidence", async () => {
  const dir = await directory(), input = path.join(dir, "trace.json"), output = path.join(dir, "report.json");
  await run(["--template", "--output", input]);
  await expect(run(["--input", input, "--output", output])).rejects.toMatchObject({ code: 2 });
  const saved = await fs.readFile(output, "utf8"), report = JSON.parse(saved);
  expect(report.status).toBe("incomplete");
  expect(report.scorerFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(report.rows[0].metrics.providerUsage.inputTokens).toBeNull();
  await expect(run(["--input", input, "--output", output])).rejects.toMatchObject({ code: 2 });
  expect(await fs.readFile(output, "utf8")).toBe(saved);
});

it("does not execute captured commands or leak malformed payloads in errors", async () => {
  const dir = await directory(), input = path.join(dir, "trace.json"), marker = path.join(dir, "never-executed");
  const { stdout } = await run(["--template"]), data = JSON.parse(stdout);
  data.trials[0].events.push({ id: "private", action: "operation", tool: "Bash", startMs: 0, endMs: 0, input: { command: `touch ${marker}` }, output: "private-output", outcome: "ok" });
  await fs.writeFile(input, JSON.stringify(data));
  const result = await run(["--input", input]).catch((error: { stdout: string; stderr: string; code: number }) => error);
  expect(result.stdout).not.toMatch(/never-executed|private-output|touch/);
  await expect(fs.stat(marker)).rejects.toThrow();
  await fs.writeFile(input, '{"secret-command":');
  await expect(run(["--input", input])).rejects.toMatchObject({ code: 2, stderr: expect.not.stringContaining("secret-command") });
});

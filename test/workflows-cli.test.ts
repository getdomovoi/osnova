import { afterEach, beforeEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runCli } from "../src/cli/cli.js";

let temporary: string;
let workspace: string;
let cache: string;
let baseline: string;
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-workflow-cli-"));
  workspace = path.join(temporary, "workspace"); cache = path.join(temporary, "cache"); baseline = path.join(temporary, "base");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "package.json"), '{"name":"fixture"}');
  await fs.writeFile(path.join(workspace, "api.ts"), "export function work() { return 1; }\n");
  await fs.writeFile(path.join(workspace, "entry.ts"), "import { work } from './api.js';\nexport function start() { return work(); }\n");
});
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });
async function command(args: string[]) {
  const output: string[] = [];
  const code = await runCli([...args, "--workspace", workspace, "--cache-dir", cache], { stdout: (text) => output.push(text), stderr: (text) => output.push(text) });
  return { code, text: output.join("\n") };
}

it("rejects the retired command names", async () => {
  for (const retired of ["ask", "scoped-ask", "grep", "skeleton", "callers", "map", "context", "impact", "nonsense"]) {
    const errors: string[] = [];
    expect(await runCli([retired, "work"], { stdout: () => {}, stderr: (text) => errors.push(text) }), retired).toBe(2);
    expect(errors.join("\n"), retired).toContain(`unknown command "${retired}"`);
  }
});

it("exposes scoped retrieval and bounded task context through the CLI", async () => {
  const scoped = await command(["ground", "work", "--scoped"]);
  expect(scoped.code).toBe(0);
  expect(scoped.text).toContain("generation");
  expect(scoped.text).toContain("api.ts#work");
  const context = await command(["footing", "work", "--task", "change", "--symbol", "api.ts#work"]);
  expect(context.code).toBe(0);
  const result = JSON.parse(context.text) as { task: string; receipt: { generation: string }; definitions: unknown[] };
  expect(result.task).toBe("change");
  expect(result.receipt.generation).toMatch(/^[a-f0-9]{64}$/);
  expect(result.definitions.length).toBeGreaterThan(0);
  expect(context.text.length).toBeLessThanOrEqual(16384);
});

it("compares preserved baseline evidence without overwriting its cache", async () => {
  await runCli(["build", workspace, "--cache-dir", baseline], { stdout: () => {}, stderr: () => {} });
  await fs.writeFile(path.join(workspace, "api.ts"), "export function work() { return 2; }\n");
  const result = await command(["settle", "--base-cache", baseline]);
  expect(result.code).toBe(0);
  expect(result.text).toContain("changed: api.ts#work");
  expect(result.text).toContain("entry.ts#start");
  await expect(command(["settle", "--base-cache", cache])).rejects.toThrow(/distinct/);
});

it("keeps doctor read-only", async () => {
  const before = await fs.readdir(workspace);
  const checked = await command(["doctor"]);
  expect(checked.code).toBe(0);
  expect((JSON.parse(checked.text) as { readOnly: boolean }).readOnly).toBe(true);
  expect(await fs.readdir(workspace)).toEqual(before);
});

it.each([
  ["ground", ["work", "--limit", "NaN"]],
  ["ground", ["work", "--scoped", "--limit", "1.5"]],
  ["thread", ["work", "--limit", "Infinity"]],
  ["warp", ["api.ts#work", "--depth", "0"]],
  ["groundwork", ["--max-dirs", "oops"]],
  ["footing", ["work", "--depth", "NaN"]],
  ["footing", ["work", "--limit=-1"]],
  ["footing", ["work", "--max-code-units", "1.5"]],
] as const)("rejects invalid numeric options for %s", async (name, args) => {
  await expect(command([name, ...args])).rejects.toThrow(/safe integer/);
});

it("rejects invalid impact depth", async () => {
  await runCli(["build", workspace, "--cache-dir", baseline], { stdout: () => {}, stderr: () => {} });
  await expect(command(["settle", "--base-cache", baseline, "--depth", "0"])).rejects.toThrow(/safe integer/);
});

it("reports a missing impact baseline as a usage error", async () => {
  await expect(command(["settle", "--base-cache", path.join(temporary, "missing")])).rejects.toThrow(/does not exist/);
});

it("caps plumb output at the shared 4096 code-unit budget", async () => {
  const callers = Array.from({ length: 300 }, (_, i) => `import { work } from './api.js';\nexport function caller${i}() { return work(); }\n`);
  await Promise.all(callers.map((text, i) => fs.writeFile(path.join(workspace, `caller${i}.ts`), text)));
  const result = await command(["plumb", "work", "--site", "entry.ts:2"]);
  expect(result.code).toBe(0);
  expect(result.text.length).toBeLessThanOrEqual(4096);
  expect(result.text).toMatch(/omitted/);
});

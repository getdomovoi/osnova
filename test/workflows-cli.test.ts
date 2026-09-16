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

it("exposes scoped retrieval and bounded task context through the CLI", async () => {
  const scoped = await command(["scoped-ask", "work"]);
  expect(scoped.code).toBe(0);
  expect(scoped.text).toContain("generation");
  expect(scoped.text).toContain("api.ts#work");
  const context = await command(["context", "work", "--task", "change", "--symbol", "api.ts#work"]);
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
  const result = await command(["impact", "--base-cache", baseline]);
  expect(result.code).toBe(0);
  expect(result.text).toContain("changed: api.ts#work");
  expect(result.text).toContain("entry.ts#start");
  await expect(command(["impact", "--base-cache", cache])).rejects.toThrow(/distinct/);
});

it("keeps doctor and setup previews read-only", async () => {
  const before = await fs.readdir(workspace);
  const checked = await command(["doctor"]);
  expect(checked.code).toBe(0);
  expect((JSON.parse(checked.text) as { readOnly: boolean }).readOnly).toBe(true);
  const output: string[] = [];
  const code = await runCli(["setup", "--preview", "--cli-path", path.join(temporary, "bin.js"), "--workspace", workspace], {
    stdout: (text) => output.push(text), stderr: (text) => output.push(text),
  });
  expect(code).toBe(0);
  expect((JSON.parse(output.join("\n")) as { mode: string }).mode).toBe("preview");
  expect(await fs.readdir(workspace)).toEqual(before);
  await expect(runCli(["setup", "--workspace", workspace])).rejects.toThrow(/preview/);
});

it.each([
  ["ask", ["work", "--limit", "NaN"]],
  ["scoped-ask", ["work", "--limit", "1.5"]],
  ["grep", ["work", "--limit", "Infinity"]],
  ["callers", ["api.ts#work", "--depth", "0"]],
  ["map", ["--max-dirs", "oops"]],
  ["context", ["work", "--depth", "NaN"]],
  ["context", ["work", "--limit=-1"]],
  ["context", ["work", "--max-code-units", "1.5"]],
] as const)("rejects invalid numeric options for %s", async (name, args) => {
  await expect(command([name, ...args])).rejects.toThrow(/safe integer/);
});

it("rejects invalid impact depth", async () => {
  await runCli(["build", workspace, "--cache-dir", baseline], { stdout: () => {}, stderr: () => {} });
  await expect(command(["impact", "--base-cache", baseline, "--depth", "0"])).rejects.toThrow(/safe integer/);
});

it("reports a missing impact baseline as a usage error", async () => {
  await expect(command(["impact", "--base-cache", path.join(temporary, "missing")])).rejects.toThrow(/does not exist/);
});

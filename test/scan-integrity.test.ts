import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { maximumIgnoreFileBytes, maximumIgnorePatterns, scanFiles } from "../src/index/scan.js";

const temporary: string[] = [];
async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-scan-integrity-"));
  temporary.push(dir);
  const root = path.join(dir, "root");
  await fs.mkdir(path.join(root, "nested"), { recursive: true });
  return root;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

it("refuses an ignore file above the byte cap instead of compiling it", async () => {
  const root = await workspace();
  await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(root, "nested/.gitignore"), `#${"x".repeat(maximumIgnoreFileBytes)}\n`);
  await expect(scanFiles(root)).rejects.toMatchObject({ diagnostic: { phase: "scan", path: "nested/.gitignore", code: "ignore-file-too-large" } });
});

it("refuses ignore rules past the scan-wide pattern budget, however they are split across directories", async () => {
  const root = await workspace();
  await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
  const half = Math.ceil(maximumIgnorePatterns / 2) + 1;
  const rules = (tag: string) => Array.from({ length: half }, (_, i) => `${tag}${i}/`).join("\n");
  await fs.writeFile(path.join(root, ".gitignore"), `# header\n\n${rules("r")}\n`);
  await fs.writeFile(path.join(root, "nested/.osnovaignore"), rules("n"));
  await expect(scanFiles(root)).rejects.toMatchObject({ diagnostic: { phase: "scan", code: "ignore-pattern-limit" } });
});

it("does not count blank lines or comments against the pattern budget", async () => {
  const root = await workspace();
  await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(root, "b.log"), "b\n");
  await fs.writeFile(path.join(root, ".gitignore"), `${"# note\n\n".repeat(maximumIgnorePatterns)}*.log\n`);
  expect((await scanFiles(root)).paths).toEqual(["a.ts"]);
});

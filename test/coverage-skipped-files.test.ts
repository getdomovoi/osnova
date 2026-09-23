import { afterAll, beforeAll, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli/cli.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-coverage-skipped-"));
  await fs.writeFile(path.join(root, "a.ts"), "export function a() { return b(); }\nexport function b() { return 1; }\n");
  await fs.writeFile(path.join(root, "big.js"), `// ${"a".repeat(1_100_000)}\n`);
});

afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

it("puts files skipped for size in the report itself, not only on stderr", async () => {
  // Redirecting stdout to a file used to keep "100.0%" and drop the only line saying big.js was never
  // indexed, because that line went to stderr.
  const stdout: string[] = [];
  const code = await runCli(["coverage", "--workspace", root, "--cache-dir", path.join(root, ".cache")], {
    stdout: (text) => stdout.push(text), stderr: () => {},
  });
  expect(code).toBe(0);
  const text = stdout.join("\n");
  expect(text).toContain("not indexed: 1 file above the 1 MB size cap; its call sites are not counted above");
  expect(text).toMatch(/^- big\.js: 1100004 bytes$/m);
});

it("adds nothing when every file was indexed", async () => {
  const clean = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-coverage-clean-"));
  try {
    await fs.writeFile(path.join(clean, "a.ts"), "export function a() { return 1; }\n");
    const stdout: string[] = [];
    await runCli(["coverage", "--workspace", clean, "--cache-dir", path.join(clean, ".cache")], { stdout: (text) => stdout.push(text), stderr: () => {} });
    expect(stdout.join("\n")).not.toContain("not indexed");
  } finally {
    await fs.rm(clean, { recursive: true, force: true });
  }
});

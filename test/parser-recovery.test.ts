import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-recovery-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
});

afterEach(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

describe("parser recovery after an extraction failure", () => {
  it("indexes later files of a language after one file fails to parse", async () => {
    await fs.writeFile(path.join(workspace, "a-breaks.sh"), 'case "$x" in\n  a) echo a ;;\nesac\n');
    await fs.writeFile(path.join(workspace, "b-healthy.sh"), "greet() {\n  echo hi\n}\n");

    const index = await buildIndex(workspace, { cacheDir });

    const healthy = index.files.get("b-healthy.sh");
    expect(healthy?.diagnostics ?? []).toEqual([]);
    expect(healthy?.symbols.map((symbol) => symbol.name)).toContain("greet");
  });

  it("reports the failing file and only the failing file", async () => {
    await fs.writeFile(path.join(workspace, "a-breaks.sh"), 'case "$x" in\n  a) echo a ;;\nesac\n');
    await fs.writeFile(path.join(workspace, "b-healthy.sh"), "greet() {\n  echo hi\n}\n");

    const index = await buildIndex(workspace, { cacheDir });

    const failedPaths = (index.diagnostics ?? []).filter((entry) => entry.phase === "parse").map((entry) => entry.path);
    expect(failedPaths).toEqual(["a-breaks.sh"]);
  });
});

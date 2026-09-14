import path from "node:path";
import os from "node:os";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("rejects stdout noise, unterminated frames and non-protocol JSON", async () => {
  const { checkFrames } = await import(pathToFileURL(path.resolve("scripts/check-package.mjs")).href);
  expect(() => checkFrames('starting\n{"jsonrpc":"2.0","id":1,"result":{}}\n')).toThrow();
  expect(() => checkFrames('{"jsonrpc":"2.0","id":1,"result":{}}')).toThrow();
  expect(() => checkFrames('{"hello":"world"}\n')).toThrow();
  expect(() => checkFrames("")).toThrow();
  expect(checkFrames('{"jsonrpc":"2.0","id":1,"result":{}}\n')).toBe(1);
});

it("rejects absent exported declaration and executable files", async () => {
  const { checkPackage } = await import(pathToFileURL(path.resolve("scripts/check-package.mjs")).href);
  const root = await mkdtemp(path.join(os.tmpdir(), "osnova-package-check-"));
  try {
    const entry = { import: "./dist/index.js", types: "./dist/index.d.ts" };
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "@getdomovoi/osnova", main: entry.import, types: entry.types,
      bin: { osnova: "./dist/bin.js" }, exports: { ".": entry, "./cli": entry, "./mcp": entry },
      dependencies: { "web-tree-sitter": "0.25.10", "tree-sitter-wasms": "0.1.13" },
    }));
    await writeFile(path.join(root, "dist/index.js"), "export {};\n");
    await expect(checkPackage(root)).rejects.toThrow(/index\.d\.ts/);
    await writeFile(path.join(root, "dist/index.d.ts"), "export {};\n");
    await expect(checkPackage(root)).rejects.toThrow(/bin\.js/);
    await writeFile(path.join(root, "dist/bin.js"), "#!/usr/bin/env node\n");
    await expect(checkPackage(root)).resolves.toHaveProperty("name", "@getdomovoi/osnova");
    const checker = path.join(root, "check-package.mjs");
    await copyFile(path.resolve("scripts/check-package.mjs"), checker);
    expect(execFileSync(process.execPath, [checker, root], { encoding: "utf8", timeout: 10_000 })).toContain("package structure: exports");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

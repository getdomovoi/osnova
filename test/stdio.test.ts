import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("initializes real stdio, exercises all eight tools, refreshes and shuts down without stdout noise", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "osnova-stdio-"));
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "probe.ts"), "export function probe() { return 1; }\nexport function caller() { return probe(); }\n");
    const { smokeStdio } = await import(pathToFileURL(path.resolve("scripts/package-smoke.mjs")).href);
    const frames = await smokeStdio({
      cliPath: path.resolve("src/cli/bin.ts"), workspace, cacheDir: path.join(root, "cache"),
      cwd: process.cwd(), nodeArgs: ["--import", "tsx"],
    });
    expect(frames).toBeGreaterThanOrEqual(8);
    expect((await readdir(root)).sort()).toEqual(["cache", "workspace"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);

it("serves the working directory when --workspace is omitted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "osnova-stdio-cwd-"));
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "probe.ts"), "export function probe() { return 1; }\nexport function caller() { return probe(); }\n");
    const { smokeStdio } = await import(pathToFileURL(path.resolve("scripts/package-smoke.mjs")).href);
    const frames = await smokeStdio({
      cliPath: path.resolve("src/cli/bin.ts"), workspace, cacheDir: path.join(root, "cache"),
      cwd: workspace, nodeArgs: ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href], omitWorkspaceArg: true,
    });
    expect(frames).toBeGreaterThanOrEqual(8);
    expect((await readdir(root)).sort()).toEqual(["cache", "workspace"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);

it("detects injected stdout noise from an otherwise functional real server", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "osnova-stdio-noise-"));
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "probe.ts"), "export function probe() { return 1; }\nexport function caller() { return probe(); }\n");
    const wrapper = path.join(root, "noisy.mjs");
    await writeFile(wrapper, `process.stdout.write("not-a-protocol-frame\\n");\nawait import(${JSON.stringify(pathToFileURL(path.resolve("src/cli/bin.ts")).href)});\n`);
    const { smokeStdio } = await import(pathToFileURL(path.resolve("scripts/package-smoke.mjs")).href);
    await expect(smokeStdio({
      cliPath: wrapper, workspace, cacheDir: path.join(root, "cache"),
      cwd: process.cwd(), nodeArgs: ["--import", "tsx"],
    })).rejects.toThrow("MCP emitted transport/protocol errors");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);

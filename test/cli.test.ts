import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli/cli.js";

function capture(): { lines: string[]; io: { stdout: (t: string) => void; stderr: (t: string) => void } } {
  const lines: string[] = [];
  return {
    lines,
    io: {
      stdout: (t) => lines.push(t),
      stderr: (t) => lines.push(`[stderr] ${t}`),
    },
  };
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-cli-ws-"));
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-cli-cache-"));
const cacheArgs = ["--cache-dir", cacheDir];

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("cli", () => {
  it("prints usage and exits 2 without a command", async () => {
    const { lines, io } = capture();
    const code = await runCli([], io);
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("usage:");
  });

  it("builds an index and reports counts", async () => {
    write("src/one.ts", "export function one(): number { return 1; }\n");
    write("src/two.ts", 'import { one } from "./one.js";\nexport function two(): number { return one() + 1; }\n');
    const { lines, io } = capture();
    const code = await runCli(["build", workspace, ...cacheArgs], io);
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/2 files, \d+ symbols, \d+ edges in \d+ms/);
  });

  it("prints the package version", async () => {
    const out: string[] = [];
    expect(await runCli(["--version"], { stdout: (text) => out.push(text), stderr: () => {} })).toBe(0);
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };
    expect(out).toEqual([pkg.version]);
  });

  it("check exits 0 when fresh, 1 after an edit, 0 after refresh via ground", async () => {
    const fresh = capture();
    expect(await runCli(["check", workspace, ...cacheArgs], fresh.io)).toBe(0);
    expect(fresh.lines.join("\n")).toContain("fresh");

    write("src/three.ts", "export function three(): number { return 3; }\n");

    const stale = capture();
    expect(await runCli(["check", workspace, ...cacheArgs], stale.io)).toBe(1);
    expect(stale.lines.join("\n")).toContain("stale");

    const asked = capture();
    expect(await runCli(["ground", "three", "--workspace", workspace, ...cacheArgs], asked.io)).toBe(0);
    expect(asked.lines.join("\n")).toContain("src/three.ts");

    const freshAgain = capture();
    expect(await runCli(["check", workspace, ...cacheArgs], freshAgain.io)).toBe(0);
  }, 60_000);

  it("outline, thread, warp, groundwork round-trip", async () => {
    const skeletonOut = capture();
    expect(await runCli(["outline", "src/two.ts", "--workspace", workspace, ...cacheArgs], skeletonOut.io)).toBe(0);
    expect(skeletonOut.lines.join("\n")).toContain("function two");

    const grepOut = capture();
    expect(await runCli(["thread", "one()", "--workspace", workspace, ...cacheArgs], grepOut.io)).toBe(0);
    expect(grepOut.lines.join("\n")).toContain("src/two.ts");

    const callersOut = capture();
    expect(await runCli(["warp", "one", "--workspace", workspace, ...cacheArgs], callersOut.io)).toBe(0);
    expect(callersOut.lines.join("\n")).toContain("src/two.ts#two");

    const fullOut = capture();
    expect(await runCli(["warp", "one", "--full", "--workspace", workspace, ...cacheArgs], fullOut.io)).toBe(0);
    expect(fullOut.lines.join("\n")).toBe(callersOut.lines.join("\n"));

    const mapOut = capture();
    expect(await runCli(["groundwork", "--workspace", workspace, ...cacheArgs], mapOut.io)).toBe(0);
    expect(mapOut.lines.join("\n")).toContain("files 3");
  }, 60_000);

  it("unreferenced lists candidates, honours scope, kinds, exported and limit", async () => {
    write("src/alone.ts", "export function alone(): number { return 1; }\nfunction hidden(): number { return 2; }\nfunction shy(): number { return 3; }\n");
    const out = capture();
    expect(await runCli(["unreferenced", "--scope", "src/alone", "--workspace", workspace, ...cacheArgs], out.io)).toBe(0);
    expect(out.lines.join("\n")).toContain("osnova unreferenced: scope src/alone, kinds class,function,method, 2 candidates listed of 2, 1 exported not listed");
    expect(out.lines.join("\n")).toContain("- function src/alone.ts#hidden src/alone.ts:2:");
    expect(out.lines.join("\n")).toContain("Candidates only: no indexed caller is not proof of no caller.");
    const exported = capture();
    expect(await runCli(["unreferenced", "--scope", "src/alone", "--kinds", "function,constant", "--exported", "-n", "1", "--workspace", workspace, ...cacheArgs], exported.io)).toBe(0);
    expect(exported.lines.join("\n")).toContain("1 candidates listed of 3, 0 exported not listed");
    expect(exported.lines.join("\n")).toContain("- function src/alone.ts#alone src/alone.ts:1 (exported):");
    const twice = capture();
    expect(await runCli(["unreferenced", "--scope", "src/alone", "--workspace", workspace, ...cacheArgs], twice.io)).toBe(0);
    expect(twice.lines).toEqual(out.lines);
    await expect(runCli(["unreferenced", "--kinds", "nope", "--workspace", workspace, ...cacheArgs], capture().io)).rejects.toThrow("symbol kinds");
    await expect(runCli(["unreferenced", "--limit=-1", "--workspace", workspace, ...cacheArgs], capture().io)).rejects.toThrow(RangeError);
    fs.rmSync(path.join(workspace, "src/alone.ts"), { force: true });
  }, 60_000);

  it("tests maps symbols to test files and back", async () => {
    write("test/two.test.ts", 'import { two } from "../src/two.js";\nexport const seen = two();\n');
    const bySymbol = capture();
    expect(await runCli(["tests", "two", "--workspace", workspace, ...cacheArgs], bySymbol.io)).toBe(0);
    expect(bySymbol.lines.join("\n")).toContain("resolved edge (calls or references the symbol):\n- test/two.test.ts (resolved edge): test/two.test.ts:2 calls import-binding");
    const noImportOnly = capture();
    expect(await runCli(["tests", "two", "--no-import-only", "--workspace", workspace, ...cacheArgs], noImportOnly.io)).toBe(0);
    expect(noImportOnly.lines.join("\n")).toContain("1 test files with a resolved edge; import-only files excluded");
    const byFile = capture();
    expect(await runCli(["tests", "--file", "test/two.test.ts", "--workspace", workspace, ...cacheArgs], byFile.io)).toBe(0);
    expect(byFile.lines.join("\n")).toContain("- function src/two.ts#two src/two.ts:2: test/two.test.ts:2 calls import-binding");
    const twice = capture();
    expect(await runCli(["tests", "two", "--workspace", workspace, ...cacheArgs], twice.io)).toBe(0);
    expect(twice.lines).toEqual(bySymbol.lines);
    await expect(runCli(["tests", "--workspace", workspace, ...cacheArgs], capture().io)).rejects.toThrow("either <symbol...> or --file");
    await expect(runCli(["tests", "two", "--file", "test/two.test.ts", "--workspace", workspace, ...cacheArgs], capture().io)).rejects.toThrow("not both");
    fs.rmSync(path.join(workspace, "test"), { recursive: true, force: true });
  }, 60_000);

  it("rejects a stray directory positional and points at --workspace", async () => {
    const stray = capture();
    expect(await runCli(["ground", "three", workspace, ...cacheArgs], stray.io)).toBe(2);
    expect(stray.lines.join("\n")).toContain(`osnova ground: ${JSON.stringify(workspace)} looks like a directory; pass the workspace with --workspace <path>`);

    const dot = capture();
    expect(await runCli(["warp", "one", ".", "--workspace", workspace, ...cacheArgs], dot.io)).toBe(2);
    expect(dot.lines.join("\n")).toContain("osnova warp: \".\" looks like a directory");

    const word = capture();
    expect(await runCli(["ground", "src", "--workspace", workspace, ...cacheArgs], word.io)).toBe(0);

    const file = capture();
    expect(await runCli(["outline", "src/two.ts", "--workspace", workspace, ...cacheArgs], file.io)).toBe(0);
    expect(file.lines.join("\n")).toContain("function two");
  });

  it("rejects unknown commands with exit 2", async () => {
    const { lines, io } = capture();
    const code = await runCli(["frobnicate"], io);
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("unknown command");
  });
});

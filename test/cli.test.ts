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

  it("rejects unknown commands with exit 2", async () => {
    const { lines, io } = capture();
    const code = await runCli(["frobnicate"], io);
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("unknown command");
  });
});

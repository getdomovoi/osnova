import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

let workspace: string;
let cacheDir: string;
let cacheArgs: string[];

function write(rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-cli-ws-"));
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-cli-cache-"));
  cacheArgs = ["--cache-dir", cacheDir];
  write("src/one.ts", "export function one(): number { return 1; }\n");
  write("src/two.ts", 'import { one } from "./one.js";\nexport function two(): number { return one() + 1; }\n');
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe("cli", () => {
  it("prints usage and exits 2 without a command", async () => {
    const { lines, io } = capture();
    const code = await runCli([], io);
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("usage:");
  });

  it("builds an index and reports counts", async () => {
    const { lines, io } = capture();
    const code = await runCli(["build", workspace, ...cacheArgs], io);
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/2 files, \d+ symbols, \d+ edges in \d+ms/);
  });

  it("builds a workspace holding a symlinked directory and names what it skipped", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-cli-symlink-"));
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-cli-symlink-cache-"));
    try {
      fs.mkdirSync(path.join(root, "pkg", "brew"), { recursive: true });
      fs.writeFileSync(path.join(root, "pkg", "brew", "formula.ts"), "export function formula(): number { return 1; }\n");
      fs.symlinkSync(path.join(root, "pkg", "brew"), path.join(root, "HomebrewFormula"));
      const { lines, io } = capture();
      const code = await runCli(["build", root, "--cache-dir", cache], io);
      expect(code).toBe(0);
      const text = lines.join("\n");
      expect(text).toContain("[stderr] osnova build: skipped 1 symlinked directory; symlinks are not followed: HomebrewFormula");
      expect(text).toMatch(/1 files, \d+ symbols/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(cache, { recursive: true, force: true });
    }
  });

  it("prints the package version", async () => {
    const out: string[] = [];
    expect(await runCli(["--version"], { stdout: (text) => out.push(text), stderr: () => {} })).toBe(0);
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };
    expect(out).toEqual([pkg.version]);
  });

  it("check exits 0 when fresh, 1 after an edit, 0 after refresh via ground", async () => {
    expect(await runCli(["build", workspace, ...cacheArgs], capture().io)).toBe(0);
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

  it("publishes the same artifact bytes after a refresh as a full rebuild", async () => {
    expect(await runCli(["build", workspace, ...cacheArgs], capture().io)).toBe(0);
    write("src/three.ts", 'import { two } from "./two.js";\nexport function three(): number { return two() + 1; }\n');
    write("src/two.ts", 'import { one } from "./one.js";\nexport function two(): number { return one() + 2; }\nexport function twin(): number { return one(); }\n');
    expect(await runCli(["ground", "three", "--workspace", workspace, ...cacheArgs], capture().io)).toBe(0);
    const rebuiltCache = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-cli-rebuilt-"));
    try {
      expect(await runCli(["build", workspace, "--cache-dir", rebuiltCache], capture().io)).toBe(0);
      const published = (dir: string): string => {
        const keys = fs.readdirSync(dir).filter((name) => /^[0-9a-f]{16}$/.test(name));
        expect(keys).toHaveLength(1);
        return path.join(dir, keys[0]!);
      };
      for (const artifact of ["index.json", "edges.json", "text.bin", "index.sha"]) {
        const refreshed = fs.readFileSync(path.join(published(cacheDir), artifact));
        expect(refreshed.equals(fs.readFileSync(path.join(published(rebuiltCache), artifact))), artifact).toBe(true);
      }
    } finally {
      fs.rmSync(rebuiltCache, { recursive: true, force: true });
    }
  }, 60_000);

  it("coverage --json pins the resolution basis of every call site across languages", async () => {
    const files: Record<string, string> = {
      "c/main.c": '#include "util.h"\nstatic int local(void) { return 1; }\nint run(void) { return util_add(1) + local() + other(); }\n',
      "c/util.h": "int util_add(int x);\n",
      "c/util.c": '#include "util.h"\nint util_add(int x) { return x + 1; }\n',
      "c/other.c": "int other(void) { return 3; }\n",
      "go/pkg/a.go": "package pkg\n\nfunc Run() int {\n\treturn helper() + local()\n}\n\nfunc local() int { return 1 }\n",
      "go/pkg/b.go": "package pkg\n\nfunc helper() int { return 2 }\n",
      "java/src/a/b/Util.java": "package a.b;\n\npublic class Util {\n    public static int helper() { return 1; }\n}\n",
      "java/src/a/b/App.java": "package a.b;\n\nimport static a.b.Util.helper;\nimport a.b.Util;\n\npublic class App {\n    int local() { return 1; }\n    int run() { return helper() + local() + Util.helper(); }\n}\n",
      "py/util.py": "def helper():\n    return 1\n",
      "py/app.py": "from .util import helper\n\nclass Box:\n    def size(self):\n        return 1\n\n    def total(self):\n        return self.size() + helper()\n\ndef local():\n    return 1\n\ndef run():\n    return helper() + local()\n",
      "rb/a.rb": "def run\n  helper() + local()\nend\n\ndef local\n  1\nend\n",
      "rb/b.rb": "def helper\n  2\nend\n",
      "rs/src/main.rs": "mod util;\nuse crate::util::helper;\nuse util::*;\n\nfn local() -> i32 { 1 }\n\nfn main() {\n    let _ = helper() + local() + starred();\n}\n",
      "rs/src/util.rs": "pub fn helper() -> i32 { 1 }\npub fn starred() -> i32 { 2 }\n",
      "ts/lib.ts": "export function shared(): number { return 1; }\n",
      "ts/app.ts": 'import { shared } from "./lib.js";\nfunction local(): number { return 1; }\nclass Counter {\n  step(): number { return 1; }\n  twice(): number { return this.step() + this.step(); }\n}\nexport function run(): number { return shared() + local() + new Counter().twice(); }\n',
    };
    fs.rmSync(path.join(workspace, "src"), { recursive: true, force: true });
    for (const [rel, content] of Object.entries(files)) write(rel, content);
    const out = capture();
    expect(await runCli(["coverage", "--json", "--workspace", workspace, ...cacheArgs], out.io)).toBe(0);
    const report = JSON.parse(out.lines.join("\n")) as { languages: { language: string; byMethod: Record<string, number> }[] };
    expect(Object.fromEntries(report.languages.map((row) => [row.language, row.byMethod]))).toEqual({
      c: { "same-file-name": 1, "unique-name": 2 },
      go: { "same-file-name": 1, "unique-name": 1 },
      java: { "imported-file-name": 1, "receiver-hint": 1, "same-file-name": 1 },
      python: { "import-binding": 2, "lexical-definition": 1, "receiver-hint": 1 },
      ruby: { "same-file-name": 1, "unique-name": 1 },
      rust: { "imported-file-name": 2, "same-file-name": 1 },
      typescript: { "import-binding": 1, "lexical-definition": 2, "receiver-hint": 2 },
    });
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
    expect(mapOut.lines.join("\n")).toContain("files 2 |");
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
  }, 60_000);

  it("rejects a stray directory positional and points at --workspace", async () => {
    const stray = capture();
    expect(await runCli(["ground", "three", workspace, ...cacheArgs], stray.io)).toBe(2);
    expect(stray.lines.join("\n")).toContain(`osnova ground: ${JSON.stringify(workspace)} looks like a directory; pass the workspace with --workspace <path>`);

    const dot = capture();
    expect(await runCli(["warp", "one", ".", ...cacheArgs], dot.io)).toBe(2);
    expect(dot.lines.join("\n")).toContain("osnova warp: \".\" looks like a directory");

    const word = capture();
    expect(await runCli(["ground", "src", "--workspace", workspace, ...cacheArgs], word.io)).toBe(0);

    const file = capture();
    expect(await runCli(["outline", "src/two.ts", "--workspace", workspace, ...cacheArgs], file.io)).toBe(0);
    expect(file.lines.join("\n")).toContain("function two");
  });

  it("keeps directory-shaped tokens as queries when --workspace is given, in regex patterns, and in relative paths", async () => {
    write("src/util/four.ts", "export function four(): number { return 4; }\n");
    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const explicit = capture();
      expect(await runCli(["footing", "how", "does", "src/util", "resolve", "names", "--workspace", ".", ...cacheArgs], explicit.io)).toBe(0);

      const absoluteExplicit = capture();
      expect(await runCli(["ground", "four", path.join(workspace, "src"), "--workspace", workspace, ...cacheArgs], absoluteExplicit.io)).toBe(0);

      const pattern = capture();
      expect(await runCli(["thread", "src/", ...cacheArgs], pattern.io)).toBe(0);

      const relative = capture();
      expect(await runCli(["ground", "four", "src/util", ...cacheArgs], relative.io)).toBe(0);

      const bare = capture();
      expect(await runCli(["ground", "src", ...cacheArgs], bare.io)).toBe(0);

      const trailing = capture();
      expect(await runCli(["ground", "four", "src/util/", ...cacheArgs], trailing.io)).toBe(2);
      expect(trailing.lines.join("\n")).toContain("osnova ground: \"src/util/\" looks like a directory");

      const trap = capture();
      expect(await runCli(["ground", "four", workspace, ...cacheArgs], trap.io)).toBe(2);
      expect(trap.lines.join("\n")).toContain(`osnova ground: ${JSON.stringify(workspace)} looks like a directory; pass the workspace with --workspace <path>`);
    } finally {
      process.chdir(previousCwd);
    }
  }, 60_000);

  it("ground --lean keeps headers, spans and signatures without inlining source", async () => {
    write("src/lean-target.ts", [
      "export function assembleReport(rows: readonly string[], title: string): string {",
      "  const header = `# ${title}`;",
      "  const body = rows.map((row) => `- ${row}`).join(\"\\n\");",
      "  return `${header}\\n\\n${body}`;",
      "}",
    ].join("\n") + "\n");
    const lean = capture();
    expect(await runCli(["ground", "assembleReport rows title", "--lean", "--workspace", workspace, ...cacheArgs], lean.io)).toBe(0);
    const leanText = lean.lines.join("\n");
    expect(leanText).toContain("src/lean-target.ts:1 function src/lean-target.ts#assembleReport lines 1-5");
    expect(leanText).not.toContain("const header =");

    const inlined = capture();
    expect(await runCli(["ground", "assembleReport rows title", "--workspace", workspace, ...cacheArgs], inlined.io)).toBe(0);
    const inlinedText = inlined.lines.join("\n");
    expect(inlinedText).toContain("const header =");
    expect(leanText.length).toBeLessThan(inlinedText.length);

    const scoped = capture();
    expect(await runCli(["ground", "assembleReport rows title", "--lean", "--scoped", "--workspace", workspace, ...cacheArgs], scoped.io)).toBe(0);
    const scopedText = scoped.lines.join("\n");
    expect(scopedText).toContain("src/lean-target.ts:1 function src/lean-target.ts#assembleReport lines 1-5");
    expect(scopedText).toContain("function assembleReport(rows: readonly string[], title: string): string");
    expect(scopedText).not.toContain("const header =");
  }, 60_000);

  it("rejects unknown commands with exit 2", async () => {
    const { lines, io } = capture();
    const code = await runCli(["frobnicate"], io);
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("unknown command");
  });
});

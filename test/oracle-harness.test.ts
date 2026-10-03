import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildIndex } from "../src/index.js";
// @ts-expect-error -- plain ESM script shipped for reproduction, without type declarations
import { scoreSites } from "../benchmarks/oracle/score.mjs";
// @ts-expect-error -- plain ESM script shipped for reproduction, without type declarations
import { claimedSites } from "../benchmarks/oracle/osnova-sites.mjs";

const oracle = {
  oracle: "fixture", entries: [
    { file: "a.py", line: 3, name: "foo", verdict: "in-repo", defs: [{ file: "b.py", line: 10 }] },
    { file: "a.py", line: 5, name: "bar", verdict: "in-repo", defs: [{ file: "b.py", line: 20 }] },
    { file: "a.py", line: 7, name: "print", verdict: "external", defs: [] },
    { file: "a.py", line: 9, name: "baz", verdict: "undecided", defs: [] },
  ],
};
const site = (line: number, calleeName: string, targetFile: string, targetStartLine: number, targetEndLine: number) =>
  ({ callerFile: "a.py", line, calleeName, targetFile, targetName: calleeName, targetStartLine, targetEndLine });

describe("scoreSites", () => {
  it("counts a claimed edge true when its target span holds the checker's declaration, within the line tolerance", () => {
    const report = scoreSites(oracle, { sites: [site(4, "foo", "b.py", 9, 12)] }, { tolerance: 1 });
    expect(report).toMatchObject({ truePositive: 1, falsePositive: 0, undecided: 0, precision: 1, oracleInRepoSites: 2, coveredInRepoSites: 1, recall: 0.5 });
  });

  it("counts a claimed edge false at a site the checker resolves elsewhere or outside the repository", () => {
    const report = scoreSites(oracle, { sites: [site(5, "bar", "b.py", 30, 40), site(7, "print", "b.py", 1, 5)] }, { tolerance: 1 });
    expect(report).toMatchObject({ truePositive: 0, falsePositive: 2, falseEdgeRate: 1, recall: 0 });
  });

  it("leaves a site the checker did not decide, or did not enumerate, out of precision", () => {
    const report = scoreSites(oracle, { sites: [site(9, "baz", "b.py", 1, 5), site(50, "qux", "b.py", 1, 5)] }, { tolerance: 1 });
    expect(report).toMatchObject({ truePositive: 0, falsePositive: 0, undecided: 2, decided: 0, precision: null });
  });

  it("counts a claimed target false when the declaration is one line outside its span", () => {
    const report = scoreSites(oracle, { sites: [site(3, "foo", "b.py", 11, 12)] }, { tolerance: 1 });
    expect(report).toMatchObject({ truePositive: 0, falsePositive: 1 });
  });

  it("does not stretch the tolerance past the requested lines", () => {
    const report = scoreSites(oracle, { sites: [site(4, "foo", "b.py", 9, 12)] }, { tolerance: 0 });
    expect(report).toMatchObject({ truePositive: 0, undecided: 1 });
  });

  // `a.get(b.get())`: one line calls the same name twice, and the checker resolves each call.
  const twice = {
    oracle: "fixture", entries: [
      { file: "a.py", line: 3, name: "get", verdict: "in-repo", defs: [{ file: "b.py", line: 10 }] },
      { file: "a.py", line: 3, name: "get", verdict: "in-repo", defs: [{ file: "b.py", line: 30 }] },
      { file: "a.py", line: 5, name: "put", verdict: "external", defs: [] },
      { file: "a.py", line: 5, name: "put", verdict: "in-repo", defs: [{ file: "b.py", line: 50 }] },
    ],
  };

  it("judges each claim at a line that calls one name twice against the call it can stand for", () => {
    const report = scoreSites(twice, { sites: [site(3, "get", "b.py", 9, 12), site(3, "get", "b.py", 29, 31), site(5, "put", "b.py", 49, 52)] }, { tolerance: 1 });
    expect(report).toMatchObject({ truePositive: 3, falsePositive: 0, oracleInRepoSites: 2, coveredInRepoSites: 2 });
  });

  it("lets one checker call stand for one claim only", () => {
    const report = scoreSites(twice, { sites: [site(3, "get", "b.py", 9, 12), site(3, "get", "b.py", 9, 12)] }, { tolerance: 1 });
    expect(report).toMatchObject({ truePositive: 1, falsePositive: 1, coveredInRepoSites: 1 });
  });

  it("pairs a line with thousands of calls of one name without exhausting the stack", () => {
    // Claim i holds calls i-1 and i (claim 0 only call 0). Taken last to first, each claim first takes call i-1, so claim
    // 0 finds call 0 taken and every claim moves along one chain as long as the line.
    const count = 20000;
    const entries = Array.from({ length: count }, (_, call) => ({ file: "a.py", line: 3, name: "f", verdict: "in-repo", defs: [{ file: "b.py", line: 10 * call + 5 }] }));
    const sites = Array.from({ length: count }, (_, claim) => site(3, "f", "b.py", Math.max(0, 10 * claim - 5), 10 * claim + 5)).reverse();
    const report = scoreSites({ oracle: "fixture", entries }, { sites }, { tolerance: 0 });
    expect(report).toMatchObject({ truePositive: count, falsePositive: 0 });
  });
});

describe("sites-python.py", () => {
  it("places an attribute call at the attribute token, never at the same name in a comment, in UTF-16 columns", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-oracle-py-"));
    const out = path.join(root, "..", `${path.basename(root)}-sites.json`);
    try {
      fs.writeFileSync(path.join(root, "m.py"), "(obj # foo\n .foo)()\n\u00e9 = 1; x.bar()\nx.\u212a()\nx.e\u0301() + x.a\u0301b()\n");
      execFileSync("python3", [path.join(__dirname, "../benchmarks/oracle/sites-python.py"), root, out]);
      const { sites } = JSON.parse(fs.readFileSync(out, "utf8"));
      expect(sites).toEqual([
        { file: "m.py", line: 2, character: 2, name: "foo" },
        { file: "m.py", line: 3, character: 9, name: "bar" },
        { file: "m.py", line: 4, character: 2, name: "K" },
        { file: "m.py", line: 5, character: 2, name: "\u00e9" },
        { file: "m.py", line: 5, character: 11, name: "\u00e1b" },
      ]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(out, { force: true }); }
  });
});

describe("sites-rust.mjs", () => {
  it("places each call at its callee name in UTF-16 columns and skips calls inside macros and through expressions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-oracle-rs-"));
    const out = path.join(root, "..", `${path.basename(root)}-sites.json`);
    try {
      fs.writeFileSync(path.join(root, "m.rs"), "fn main() {\n    let é = 1; foo(é);\n    a::b::<u8>(x.m(), \"😀\".len());\n    (f)(); println!(\"{}\", g());\n}\n");
      execFileSync(process.execPath, [path.join(__dirname, "../benchmarks/oracle/sites-rust.mjs"), root, out]);
      const { sites } = JSON.parse(fs.readFileSync(out, "utf8"));
      expect(sites).toEqual([
        { file: "m.rs", line: 2, character: 15, name: "foo" },
        { file: "m.rs", line: 3, character: 7, name: "b" },
        { file: "m.rs", line: 3, character: 17, name: "m" },
        { file: "m.rs", line: 3, character: 27, name: "len" },
      ]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(out, { force: true }); }
  });
});

describe("claimedSites", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-oracle-ws-"));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-oracle-cache-"));
  afterAll(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(cacheDir, { recursive: true, force: true }); });

  it("lists one claim per resolved call edge, with the target's file, name and span, and nothing unresolved", async () => {
    fs.writeFileSync(path.join(workspace, "lib.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
    fs.writeFileSync(path.join(workspace, "main.ts"), 'import { add } from "./lib.js";\nexport function run(): number {\n  missing();\n  return add(1, 2);\n}\n');
    const index = await buildIndex(workspace, { cacheDir });
    const { sites } = claimedSites(index);
    expect(sites).toEqual([
      { callerFile: "main.ts", line: 4, calleeName: "add", targetFile: "lib.ts", targetName: "add", targetStartLine: 1, targetEndLine: 3, basis: "import-binding" },
    ]);
  }, 60_000);

  it("claims the overload a call's argument count names, and no declaration when it names none", async () => {
    const java = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-oracle-java-"));
    try {
      fs.writeFileSync(path.join(java, "Box.java"), [
        "class Box {",
        "  void put(int a) { }",
        "  void put(int a, int b) { }",
        "  void put(String a, String b) { }",
        "  void run() {",
        "    put(1);",
        "    put(1, 2);",
        "  }",
        "}",
      ].join("\n"));
      const index = await buildIndex(java, { cacheDir });
      const { sites, overloadUndetermined } = claimedSites(index);
      expect(sites).toEqual([
        { callerFile: "Box.java", line: 6, calleeName: "put", targetFile: "Box.java", targetName: "put", targetStartLine: 2, targetEndLine: 2, basis: "same-file-name" },
      ]);
      expect(overloadUndetermined).toBe(1);
    } finally { fs.rmSync(java, { recursive: true, force: true }); }
  }, 60_000);
});

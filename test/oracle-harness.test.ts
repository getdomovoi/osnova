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
});

describe("sites-python.py", () => {
  it("places an attribute call at the attribute token, never at the same name in a comment, in UTF-16 columns", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-oracle-py-"));
    const out = path.join(root, "..", `${path.basename(root)}-sites.json`);
    try {
      fs.writeFileSync(path.join(root, "m.py"), "(obj # foo\n .foo)()\n\u00e9 = 1; x.bar()\n");
      execFileSync("python3", [path.join(__dirname, "../benchmarks/oracle/sites-python.py"), root, out]);
      const { sites } = JSON.parse(fs.readFileSync(out, "utf8"));
      expect(sites).toEqual([
        { file: "m.py", line: 2, character: 2, name: "foo" },
        { file: "m.py", line: 3, character: 9, name: "bar" },
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
});

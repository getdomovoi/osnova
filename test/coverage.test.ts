import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex, indexGeneration } from "../src/index.js";
import { resolutionCoverage } from "../src/query/coverage.js";
import { formatCoverage } from "../src/query/format.js";

let temporary: string;
beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-coverage-")); });
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

describe("resolution coverage", () => {
  it("counts call sites per language with methods and reasons", async () => {
    const workspace = path.join(temporary, "ws");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "a.ts"), "import { f } from './b.js';\nexport function g() { f(); h(); }\n");
    await fs.writeFile(path.join(workspace, "b.ts"), "export function f() {}\n");
    await fs.writeFile(path.join(workspace, "c.py"), "def x():\n    y()\n");
    const index = await buildIndex(workspace, { cacheDir: path.join(temporary, "cache") });
    const report = resolutionCoverage(index);
    expect(report.generation).toBe(indexGeneration(index));
    expect(report.total).toMatchObject({ language: "all", files: 3, calls: 3, resolved: 1, ambiguous: 0, unresolved: 2, imports: 1, importsResolved: 1, resolvedShare: 0.3333 });
    expect(report.total.byMethod).toEqual({ "import-binding": 1 });
    expect(report.total.byReason).toEqual({ "binding-blocked": 2 });
    expect(report.languages.map((row) => row.language)).toEqual(["python", "typescript"]);
    expect(report.languages.find((row) => row.language === "python")).toMatchObject({ files: 1, calls: 1, resolved: 0, unresolved: 1, resolvedShare: 0 });
    expect(report.limitations).toEqual(["indexed-call-sites-only", "resolution-is-heuristic-not-type-inference", "unindexed-files-not-counted"]);
    const text = formatCoverage(report);
    expect(text.split("\n")[0]).toBe("osnova coverage: 1/3 call sites resolved (33.3%)");
    expect(text).toContain("typescript: files 2, symbols 2, calls 2, resolved 1 (50.0%), ambiguous 0, unresolved 1");
    expect(text).toContain("unresolved by reason:\n- binding-blocked: 2");
    expect(text).toContain("limitations: indexed-call-sites-only");
  });

  it("returns zero shares on an index with no calls", async () => {
    const workspace = path.join(temporary, "ws");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "a.ts"), "export const one = 1;\n");
    const index = await buildIndex(workspace, { cacheDir: path.join(temporary, "cache") });
    const report = resolutionCoverage(index);
    expect(report.total).toMatchObject({ calls: 0, resolved: 0, resolvedShare: 0 });
    expect(report.languages).toHaveLength(1);
  });
});

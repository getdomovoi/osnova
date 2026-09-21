import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex, symbolsUnderTest, testsFor } from "../src/index.js";
import { formatSymbolsUnderTest, formatTestsFor } from "../src/query/format.js";
import type { OsnovaIndex } from "../src/index.js";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-tests-ws-"));
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-tests-cache-"));
let index: OsnovaIndex;

function write(rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(async () => {
  write("src/math.ts", "export function add(a: number, b: number): number { return a + b; }\nexport function mul(a: number, b: number): number { return a * b; }\n");
  write("test/direct.test.ts", 'import { add } from "../src/math.js";\nimport { it } from "vitest";\nfunction helper(): number { return add(1, 2); }\nit("adds", () => { add(1, 2); helper(); });\n');
  write("test/import-only.test.ts", 'import { add } from "../src/math.js";\nimport { it } from "vitest";\nit("imports", () => { void 0; });\n');
  write("test/string-only.test.ts", 'import { it } from "vitest";\nit("names", () => { const s = "add"; void s; });\n');
  index = await buildIndex(workspace, { cacheDir });
}, 60_000);

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe("testsFor", () => {
  it("lists direct callers and file importers, never a string mention", () => {
    const result = testsFor(index, ["add"]);
    expect(result.unknownSymbols).toEqual([]);
    expect(result.symbols).toHaveLength(1);
    const [entry] = result.symbols;
    expect(entry!.symbol.qualifiedName).toBe("src/math.ts#add");
    expect(entry!.tests.map((test) => [test.file, test.basis])).toEqual([
      ["test/direct.test.ts", "test-path-and-resolved-edge"],
      ["test/import-only.test.ts", "test-path-and-file-import"],
    ]);
    expect(entry!.tests[0]!.sites.map((site) => [site.line, site.kind, site.method, site.fromSymbol])).toEqual([
      [3, "calls", "import-binding", "test/direct.test.ts#helper"],
      [4, "calls", "import-binding", null],
    ]);
    expect(entry!.tests[1]!.sites).toEqual([{ line: 1, kind: "imports", method: "import-path", fromSymbol: null }]);
    expect(JSON.stringify(result)).not.toContain("string-only");
    expect(result.limitations).toContain("no-indexed-test-is-not-proof-of-no-test");
  });

  it("reports unknown symbols, resolves qualified names and clips with exact counts", () => {
    const result = testsFor(index, ["src/math.ts#mul", "nothing", "add", "src/other.ts#add"], { limit: 1, sitesPerFile: 1 });
    expect(result.unknownSymbols).toEqual(["nothing", "src/other.ts#add"]);
    expect(result.symbols.map((entry) => entry.symbol.qualifiedName)).toEqual(["src/math.ts#add", "src/math.ts#mul"]);
    expect(result.symbols[0]!.tests).toHaveLength(1);
    expect(result.symbols[0]!.omittedTests).toBe(1);
    expect(result.symbols[0]!.tests[0]!.omittedSites).toBe(1);
    expect(result.symbols[1]!.tests.map((test) => test.basis)).toEqual(["test-path-and-file-import"]);
    expect(() => testsFor(index, [])).toThrow("at least one symbol");
    expect(() => testsFor(index, ["add"], { limit: -1 })).toThrow(RangeError);
  });

  it("formats exact file:line with the notice", () => {
    const text = formatTestsFor(testsFor(index, ["add"]));
    expect(text).toContain("osnova tests: 1 symbols; 1 test files with a resolved edge; 1 import the file only");
    expect(text).toContain("function src/math.ts#add src/math.ts:1: 1 test files with a resolved edge; 1 import the file only");
    expect(text).toContain("- test/direct.test.ts (resolved edge): test/direct.test.ts:3,4 calls import-binding");
    expect(text).toContain("- test/import-only.test.ts (imports the file only): test/import-only.test.ts:1 imports import-path");
    expect(text).toContain("No indexed test is not proof of no test");
    expect(text).not.toContain("string-only");
  });

  it("prints the two evidence tiers under separate headings and names an empty resolved tier", () => {
    const both = formatTestsFor(testsFor(index, ["add"])).split("\n");
    expect(both.slice(0, 6)).toEqual([
      "osnova tests: 1 symbols; 1 test files with a resolved edge; 1 import the file only",
      "function src/math.ts#add src/math.ts:1: 1 test files with a resolved edge; 1 import the file only",
      "resolved edge (calls or references the symbol):",
      "- test/direct.test.ts (resolved edge): test/direct.test.ts:3,4 calls import-binding",
      "imports the file only (no indexed call or reference to the symbol):",
      "- test/import-only.test.ts (imports the file only): test/import-only.test.ts:1 imports import-path",
    ]);
    const importOnly = formatTestsFor(testsFor(index, ["mul"])).split("\n");
    expect(importOnly.slice(0, 6)).toEqual([
      "osnova tests: 1 symbols; 0 test files with a resolved edge; 2 import the file only",
      "function src/math.ts#mul src/math.ts:2: 0 test files with a resolved edge; 2 import the file only",
      "no indexed test file has a resolved call or reference edge to src/math.ts#mul",
      "imports the file only (no indexed call or reference to the symbol):",
      "- test/direct.test.ts (imports the file only): test/direct.test.ts:1 imports import-path",
      "- test/import-only.test.ts (imports the file only): test/import-only.test.ts:1 imports import-path",
    ]);
    expect(importOnly.at(-2)).toContain("No indexed test is not proof of no test");
    expect(importOnly.at(-1)).toMatch(/^limitations: /);
    const excluded = testsFor(index, ["add", "mul"], { includeImportOnly: false });
    expect(excluded.symbols.map((entry) => entry.tests.map((test) => test.basis))).toEqual([["test-path-and-resolved-edge"], []]);
    expect(excluded.symbols.map((entry) => entry.omittedTests)).toEqual([0, 0]);
    const excludedText = formatTestsFor(excluded).split("\n");
    expect(excludedText[0]).toBe("osnova tests: 2 symbols; 1 test files with a resolved edge; import-only files excluded");
    expect(excludedText).toContain("function src/math.ts#mul src/math.ts:2: 0 test files with a resolved edge; import-only files excluded");
    expect(excludedText).toContain("no indexed test file has a resolved call or reference edge to src/math.ts#mul");
    expect(excludedText.join("\n")).not.toContain("imports the file only (");
  });
});

describe("symbolsUnderTest", () => {
  it("lists the non-test symbols and files one test reaches", () => {
    const result = symbolsUnderTest(index, "test/direct.test.ts");
    expect(result.isTestPath).toBe(true);
    expect(result.symbols.map((entry) => entry.symbol.qualifiedName)).toEqual(["src/math.ts#add"]);
    expect(result.symbols[0]!.sites.map((site) => site.line)).toEqual([3, 4]);
    expect(result.imports.map((entry) => [entry.file, entry.lines])).toEqual([["src/math.ts", [1]]]);
    expect(result.unresolvedEdges).toBeGreaterThan(0);
    expect(result.symbols[0]!.sites.map((site) => site.fromSymbol)).toEqual(["test/direct.test.ts#helper", null]);
    const none = symbolsUnderTest(index, "test/string-only.test.ts");
    expect(none.symbols).toEqual([]);
    expect(none.imports).toEqual([]);
    expect(() => symbolsUnderTest(index, "test/missing.test.ts")).toThrow("not indexed");
    const text = formatSymbolsUnderTest(result);
    expect(text).toContain("osnova tests: test/direct.test.ts: 1 symbols under test, 1 imported files,");
    expect(text).toContain("- function src/math.ts#add src/math.ts:1: test/direct.test.ts:3,4 calls import-binding");
    expect(text).toContain("imports:\n- src/math.ts at test/direct.test.ts:1");
  });

  it("is deterministic across repeated queries and a rebuilt index", async () => {
    const first = [formatTestsFor(testsFor(index, ["add", "mul"])), formatSymbolsUnderTest(symbolsUnderTest(index, "test/direct.test.ts"))];
    const rebuilt = await buildIndex(workspace, { cacheDir });
    const second = [formatTestsFor(testsFor(rebuilt, ["mul", "add"])), formatSymbolsUnderTest(symbolsUnderTest(rebuilt, "test/direct.test.ts"))];
    expect(second).toEqual(first);
    expect(JSON.stringify(testsFor(index, ["add"]))).toBe(JSON.stringify(testsFor(index, ["add"])));
  }, 60_000);
});

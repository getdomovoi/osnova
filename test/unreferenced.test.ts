import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex, unreferenced } from "../src/index.js";
import { formatUnreferenced } from "../src/query/format.js";
import type { OsnovaIndex } from "../src/index.js";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-unref-ws-"));
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-unref-cache-"));
let index: OsnovaIndex;

function write(rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(async () => {
  write("package.json", JSON.stringify({ name: "fixture", bin: { fixture: "src/cli.ts" } }));
  write("src/lib.ts", [
    "export function used(): number { return 1; }",
    "export function unusedExported(): number { return 2; }",
    "function unusedLocal(): number { return unusedLocal(); }",
    "function leadOnly(): number { return 3; }",
    "function mentionedInString(): number { return 4; }",
    "export function outer(): number { function twin(): number { return 9; } return twin(); }",
    "export function other(): number { function twin(): number { return 10; } return 11; }",
    "export class Widget { constructor() { void 0; } render(): number { return this.size(); } size(): number { return 5; } }",
    "function comparator(a: number, b: number): number { return a - b; }",
    "export function sorted(xs: number[]): number[] { return xs.sort(comparator); }",
  ].join("\n"));
  write("src/main.ts", 'import { used } from "./lib.js";\nexport function main(): number { return used(); }\n');
  write("src/other.ts", 'export function run(): number { return leadOnly(); }\nexport const label = "mentionedInString";\n');
  write("src/index.ts", "export function fromIndex(): number { return 6; }\n");
  write("src/cli.ts", "export function cliMain(): number { return 7; }\n");
  write("src/shadow.ts", [
    "export const host = {",
    "  guard(inst: { run: unknown }) { const wrapped = (x: number): number => x + 1; inst.run = wrapped; },",
    "  attach(inst: { run: unknown }) { const wrapped = (x: number): number => x + 2; inst.run = wrapped; },",
    "};",
  ].join("\n"));
  write("src/defaulted.ts", "export default function defaulted(): number { return 8; }\n");
  write("test/lib.test.ts", 'import { unusedExported } from "../src/lib.js";\nexport function fromTest(): number { return unusedExported(); }\n');
  index = await buildIndex(workspace, { cacheDir });
}, 60_000);

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe("unreferenced", () => {
  it("lists symbols with no in-edge from outside their own definition, exported ones only on request", () => {
    const result = unreferenced(index);
    expect(result.candidates.map((c) => c.symbol.qualifiedName)).toEqual([
      "src/lib.ts#unusedLocal", "src/lib.ts#leadOnly", "src/lib.ts#mentionedInString",
    ]);
    expect(result.candidates.map((c) => [c.exported, c.unresolvedSameNameSites, c.testSites, c.mentions])).toEqual([
      [false, 0, 0, 0], [false, 1, 0, 1], [false, 0, 0, 1],
    ]);
    const twins = unreferenced(index, { includeExported: true }).candidates.filter((c) => c.symbol.name === "twin");
    expect(twins.map((c) => [c.symbol.qualifiedName, c.mentions])).toEqual([["src/lib.ts#other.twin", 2]]);
    expect(result.exportedNotListed).toBe(8);
    expect(index.edges.filter((e) => e.kind === "references" && e.toSymbol === "src/lib.ts#comparator").map((e) => `${e.fromSymbol}:${e.line}`)).toEqual(["src/lib.ts#sorted:10"]);
    expect(result.entryPoints).toEqual({ main: 1, "default-export": 1, "index-file": 1, "package-bin": 1, "test-file": 1, constructor: 1, "python-dunder": 0 });
    expect(result.mentionsScanned).toBe(true);
    expect(result.withoutLeads).toBe(1);
    const withExported = unreferenced(index, { includeExported: true });
    expect(withExported.candidates.map((c) => [c.symbol.qualifiedName, c.exported, c.testSites])).toEqual([
      ["src/lib.ts#unusedExported", true, 1], ["src/lib.ts#unusedLocal", false, 0], ["src/lib.ts#leadOnly", false, 0],
      ["src/lib.ts#mentionedInString", false, 0], ["src/lib.ts#outer", true, 0], ["src/lib.ts#other", true, 0],
      ["src/lib.ts#other.twin", true, 0], ["src/lib.ts#Widget", true, 0], ["src/lib.ts#Widget.render", true, 0],
      ["src/lib.ts#sorted", true, 0], ["src/other.ts#run", true, 0],
    ]);
    expect(withExported.kinds).toEqual(["class", "function", "method"]);
    const constants = unreferenced(index, { kinds: ["constant"], includeExported: true });
    expect(constants.candidates.map((c) => c.symbol.qualifiedName)).toEqual(["src/other.ts#label", "src/shadow.ts#host"]);
    expect(withExported.exportedNotListed).toBe(0);
    expect(JSON.stringify(withExported)).not.toContain("Widget.size");
    expect(JSON.stringify(withExported)).not.toContain("fromTest");
  });

  it("never lists a shadowed declaration, since no reference to it can be recorded", () => {
    const result = unreferenced(index);
    expect(index.symbols.get("src/shadow.ts#wrapped")?.shadowed).toBe(true);
    expect(result.candidates.map((c) => c.symbol.qualifiedName)).not.toContain("src/shadow.ts#wrapped");
    expect(result.shadowedNotListed).toBe(1);
    expect(unreferenced(index, { scope: "src/lib.ts" }).shadowedNotListed).toBe(0);
    expect(formatUnreferenced(result)).toContain("1 shadowed not listed");
  });

  it("filters by scope and kinds, clips with an exact count and is deterministic", () => {
    const scoped = unreferenced(index, { scope: "src/other", includeExported: true });
    expect(scoped.candidates.map((c) => c.symbol.qualifiedName)).toEqual(["src/other.ts#run"]);
    expect(scoped.scope).toBe("src/other");
    expect(unreferenced(index, { kinds: ["class"] }).candidates).toEqual([]);
    expect(unreferenced(index, { kinds: ["class"], includeExported: true }).candidates.map((c) => c.symbol.name)).toEqual(["Widget"]);
    const clipped = unreferenced(index, { limit: 1 });
    expect(clipped.candidates.map((c) => c.symbol.qualifiedName)).toEqual(["src/lib.ts#unusedLocal"]);
    expect(clipped.omitted).toBe(2);
    expect(JSON.stringify(unreferenced(index))).toBe(JSON.stringify(unreferenced(index)));
    expect(() => unreferenced(index, { limit: -1 })).toThrow(RangeError);
    expect(() => unreferenced(index, { kinds: ["nope" as never] })).toThrow("symbol kinds");
  });

  it("formats candidates with leads, the exclusion rule and the not-proof notice", () => {
    const text = formatUnreferenced(unreferenced(index));
    expect(text).toMatch(/^osnova unreferenced: scope \., kinds class,function,method, 3 candidates listed of 3, 8 exported not listed/);
    expect(text).toContain("- function src/lib.ts#unusedLocal src/lib.ts:3: 0 unresolved same-name sites, 0 test sites, 0 text mentions in non-test files; no leads");
    expect(text).toContain("1 of 3 listed candidates have no lead at all");
    expect(text).toContain("- function src/lib.ts#leadOnly src/lib.ts:4: 1 unresolved same-name sites, 0 test sites, 1 text mentions in non-test files");
    expect(text).toContain("- function src/lib.ts#mentionedInString src/lib.ts:5: 0 unresolved same-name sites, 0 test sites, 1 text mentions in non-test files");
    expect(text).toContain("entry points excluded: main 1, default export 1, index file 1, package.json bin 1, test file 1, constructor 1");
    expect(text).toContain("Candidates only: no indexed caller is not proof of no caller. Dynamic calls, reflection, string references and external consumers are not indexed.");
    expect(text).toContain("limitations:");
    expect(formatUnreferenced(unreferenced(index, { includeExported: true }))).toContain("- function src/lib.ts#unusedExported src/lib.ts:2 (exported): 0 unresolved same-name sites, 1 test sites, 0 text mentions in non-test files");
  });
});

describe("unreferenced Python runtime hooks", () => {
  const pyWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-unref-py-ws-"));
  const pyCache = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-unref-py-cache-"));
  let pyIndex: OsnovaIndex;

  beforeAll(async () => {
    fs.mkdirSync(path.join(pyWorkspace, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(pyWorkspace, "pkg", "utils.py"), [
      "def __getattr__(name):",
      "    raise AttributeError(name)",
      "",
      "class Box:",
      "    def __init__(self):",
      "        self.v = 1",
      "    def __repr__(self):",
      "        return 'Box'",
      "",
      "def _dead():",
      "    return 1",
      "",
    ].join("\n"));
    pyIndex = await buildIndex(pyWorkspace, { cacheDir: pyCache });
  }, 60_000);

  afterAll(() => {
    fs.rmSync(pyWorkspace, { recursive: true, force: true });
    fs.rmSync(pyCache, { recursive: true, force: true });
  });

  it("never lists a Python dunder, since the runtime calls it without a call site", () => {
    const result = unreferenced(pyIndex, { includeExported: true });
    expect(result.candidates.map((c) => c.symbol.qualifiedName)).toEqual(["pkg/utils.py#Box", "pkg/utils.py#_dead"]);
    expect(result.entryPoints.constructor).toBe(1);
    expect(result.entryPoints["python-dunder"]).toBe(2);
    expect(formatUnreferenced(result)).toContain("constructor 1, python dunder 2");
  });
});

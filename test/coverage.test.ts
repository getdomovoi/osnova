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
    expect(report.total.byReason).toEqual({ "unbound-global": 2 });
    expect(report.languages.map((row) => row.language)).toEqual(["python", "typescript"]);
    expect(report.languages.find((row) => row.language === "python")).toMatchObject({ files: 1, calls: 1, resolved: 0, unresolved: 1, resolvedShare: 0 });
    expect(report.limitations).toEqual(["indexed-call-sites-only", "resolution-is-heuristic-not-type-inference", "unindexed-files-not-counted", "unresolved-import-calls-are-import-target-unresolved-edges", "unbound-global-calls-are-names-with-no-binding-in-the-file"]);
    expect(report.total).toMatchObject({ unresolvedImportCalls: 0, resolvedShareExcludingUnresolvedImports: 0.3333, unboundGlobalCalls: 2, resolvedShareExcludingExternal: 1 });
    const text = formatCoverage(report);
    expect(text.split("\n")[0]).toBe("osnova coverage: 1/3 call sites resolved (33.3%); 0 call sites go through an import the index cannot resolve, 2 call a name with no binding in the file");
    expect(text).toContain("typescript: files 2, symbols 2, calls 2, resolved 1 (50.0%; 100.0% of the 1 not going through an unresolved import or an unbound global), ambiguous 0, unresolved 1");
    expect(text).toContain("unresolved by reason:\n- unbound-global: 2");
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

  it("keeps ambient declarations out of the unbound-global bucket", async () => {
    const workspace = path.join(temporary, "ambient"); await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "globals.d.ts"), "declare function shared(): void;\n");
    await fs.writeFile(path.join(workspace, "a.ts"), "declare function here(): void;\nfunction local() {}\nexport function use() {\n  here();\n  shared();\n  local();\n  missing();\n}\n");
    const index = await buildIndex(workspace, { cacheDir: path.join(temporary, "cache-ambient") });
    const reasons = index.outgoing("a.ts#use").map((edge) => { const r = edge.evidence?.source === "syntax" ? edge.evidence.resolution : undefined; return [edge.toName, r?.status === "unresolved" ? r.reason : edge.toSymbol]; });
    expect(reasons).toEqual([["here", "binding-blocked"], ["shared", "binding-blocked"], ["local", "a.ts#local"], ["missing", "unbound-global"]]);
    expect(resolutionCoverage(index).total).toMatchObject({ calls: 4, resolved: 1, unboundGlobalCalls: 1, resolvedShareExcludingExternal: 0.3333 });
  });

  it("reads ambient declarations with comment, string, module and global scopes in mind", async () => {
    const workspace = path.join(temporary, "ambient2"); await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "globals.d.ts"), '// declare function commented(): void;\n/*\nfunction blockCommented(): void;\n*/\nconst quoted = "declare function inString(): void";\ntype T = "https://example"; declare function afterSlashes(): void;\ntype Q = import("x").T; declare function afterImportType(): void;\ndeclare module "x" {\n  function moduleLocal(): void;\n}\ndeclare global {\n  function fromGlobal(): void;\n}\ndeclare function plain(): void;\n');
    await fs.writeFile(path.join(workspace, "module.d.ts"), "export {};\nexport declare function exported(): void;\ndeclare global {\n  function augmented(): void;\n}\n");
    await fs.writeFile(path.join(workspace, "a.ts"), "export function use() {\n  commented();\n  blockCommented();\n  inString();\n  moduleLocal();\n  fromGlobal();\n  plain();\n  afterSlashes();\n  exported();\n  augmented();\n  afterImportType();\n}\n");
    await fs.writeFile(path.join(workspace, "b.py"), "def use():\n    plain()\n");
    const index = await buildIndex(workspace, { cacheDir: path.join(temporary, "cache-ambient2") });
    const reason = (symbol: string) => index.outgoing(symbol).map((edge) => { const r = edge.evidence?.source === "syntax" ? edge.evidence.resolution : undefined; return [edge.toName, r?.status === "unresolved" ? r.reason : edge.toSymbol]; });
    expect(reason("a.ts#use")).toEqual([["commented", "unbound-global"], ["blockCommented", "unbound-global"], ["inString", "unbound-global"], ["moduleLocal", "unbound-global"], ["fromGlobal", "binding-blocked"], ["plain", "binding-blocked"], ["afterSlashes", "binding-blocked"], ["exported", "unbound-global"], ["augmented", "binding-blocked"], ["afterImportType", "binding-blocked"]]);
    expect(reason("b.py#use")).toEqual([["plain", "unbound-global"]]);
  });
});

describe("external chains", () => {
  it("classifies chains that end on a builtin type or an unresolved import as external", async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-external-chains-"));
    try {
      const root = path.join(temporary, "ws"); await fs.mkdir(root);
      await fs.writeFile(path.join(root, "lib.ts"), "import { Conn } from 'pg';\nexport class Foo { hit() {} }\nexport class Store {\n  names: string[] = [];\n  byId: Map<number, string> = new Map();\n  conn: Conn;\n  foos: Foo[] = [];\n  label(): string { return ''; }\n  make(): Foo { return new Foo(); }\n  missing(): Foo | undefined { return undefined; }\n}\n");
      await fs.writeFile(path.join(root, "a.ts"), "import { Store } from './lib.js';\nexport function use(s: Store) {\n  s.names[0].trim();\n  for (const n of s.names) n.trim();\n  s.byId.get(1)?.trim();\n  s.conn.query();\n  s.label().trim();\n  s.make().nope();\n  s.foos[0].nope();\n  s.missing().hit();\n}\n");
      const index = await buildIndex(root, { cacheDir: path.join(temporary, "cache") });
      const reasons = [...index.outgoing("a.ts#use")].filter((edge) => edge.kind === "calls" && ["trim", "query", "nope", "hit"].includes(edge.toName)).sort((a, b) => a.line - b.line).map((edge) => { const resolution = (edge.evidence as { resolution?: { status: string; reason?: string } } | undefined)?.resolution; return `${edge.toName}:${resolution?.status === "unresolved" ? resolution.reason : resolution?.status}`; });
      expect(reasons).toEqual(["trim:unbound-global", "trim:unbound-global", "trim:unbound-global", "query:import-target-unresolved", "trim:unbound-global", "nope:receiver-unresolved", "nope:receiver-unresolved", "hit:resolved"]);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });

  it("Python and TypeScript literal receivers, and typed-language names no file defines, classify as external", async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-coverage-"));
    try {
      const root = path.join(temporary, "ws"); await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, "b.py"), "def use(xs):\n    rv = []\n    rv.append(1)\n    \", \".join(xs)\n    {}.get(\"a\")\n    \"x\".strip()\n    s = {1}\n    s.add(2)\n    return len(xs)\n");
      await fs.writeFile(path.join(root, "c.ts"), "export function string() { return 1; }\nexport function use(xs: string[], s: string) {\n  const out = [];\n  out.push(1);\n  `a${xs}`.trim();\n  /x/.test('y');\n  s.endsWith('z');\n}\n");
      await fs.mkdir(path.join(root, "src/main/java/a"), { recursive: true });
      await fs.writeFile(path.join(root, "src/main/java/a/Helper.java"), "package a;\n\npublic class Helper { void hi() {} }\n");
      await fs.writeFile(path.join(root, "src/main/java/a/App.java"), "package a;\n\npublic class App {\n  void f() {\n    new Helper();\n    throw new IllegalArgumentException(\"x\");\n  }\n  void g() {\n    new StringBuilder();\n  }\n}\n");
      await fs.writeFile(path.join(root, "go.mod"), "module example.com/app\n");
      await fs.writeFile(path.join(root, "m.go"), "package m\n\nfunc use(xs []int) int { return len(xs) }\n");
      const index = await buildIndex(root, { cacheDir: path.join(temporary, "cache") });
      const reason = (symbol: string) => [...index.outgoing(symbol)].filter((edge) => edge.kind === "calls").sort((a, b) => a.line - b.line).map((edge) => `${edge.toName}:${edge.evidence?.source === "syntax" ? (edge.evidence.resolution.status === "resolved" ? edge.toSymbol : edge.evidence.resolution.status === "unresolved" ? edge.evidence.resolution.reason : "ambiguous") : "?"}`);
      expect(reason("b.py#use")).toEqual(["append:unbound-global", "join:unbound-global", "get:unbound-global", "strip:unbound-global", "add:unbound-global", "len:unbound-global"]);
      expect(reason("c.ts#use")).toEqual(["push:unbound-global", "trim:unbound-global", "test:unbound-global", "endsWith:unbound-global"]);
      expect(reason("src/main/java/a/App.java#App.f")).toEqual(["Helper:src/main/java/a/Helper.java#Helper", "IllegalArgumentException:unbound-global"]);
      expect(reason("src/main/java/a/App.java#App.g")).toEqual(["StringBuilder:unbound-global"]);
      expect(reason("m.go#use")).toEqual(["len:unbound-global"]);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
});

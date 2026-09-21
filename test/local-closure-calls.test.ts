import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-local-closure-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
});

afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

async function build(files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await fs.writeFile(path.join(workspace, file), text);
  }
  return buildIndex(workspace, { cacheDir });
}

type Index = Awaited<ReturnType<typeof build>>;
const callAt = (index: Index, file: string, line: number, toName: string) =>
  index.edges.find((edge) => edge.kind === "calls" && edge.fromFile === file && edge.line === line && edge.toName === toName);
const resolution = (index: Index, file: string, line: number, toName: string) => {
  const edge = callAt(index, file, line, toName);
  expect(edge, `${file}:${line} ${toName}`).toBeDefined();
  const evidence = edge?.evidence;
  return { toSymbol: edge?.toSymbol, ...(evidence?.source === "syntax" ? evidence.resolution : {}) };
};

describe("calls to a local closure", () => {
  const closures = [
    /* 1 */ "import { helper } from \"./lib\";",
    /* 2 */ "export function outer(): void {",
    /* 3 */ "  early();",
    /* 4 */ "  const early = () => 1;",
    /* 5 */ "  early();",
    /* 6 */ "  const rec = (n: number): number => (n > 0 ? rec(n - 1) : 0);",
    /* 7 */ "  rec(3);",
    /* 8 */ "  const shadow = () => 2;",
    /* 9 */ "  const inner = (shadow: () => number) => shadow();",
    /* 10 */ "  inner(shadow);",
    /* 11 */ "  let re = () => 3;",
    /* 12 */ "  re = () => 4;",
    /* 13 */ "  re();",
    /* 14 */ "  const viaImport = helper;",
    /* 15 */ "  viaImport();",
    /* 16 */ "  const viaGlobal = parseInt;",
    /* 17 */ "  viaGlobal(\"1\");",
    /* 18 */ "  const viaLocal = rec;",
    /* 19 */ "  viaLocal(1);",
    /* 20 */ "  function decl(): void { decl(); }",
    /* 21 */ "  decl = () => undefined;",
    /* 22 */ "  decl();",
    /* 23 */ "}",
    /* 24 */ "export const adapter = {",
    /* 25 */ "  extract(): void {",
    /* 26 */ "    const visit = (n: number): void => { if (n > 0) visit(n - 1); };",
    /* 27 */ "    visit(2);",
    /* 28 */ "  },",
    /* 29 */ "};",
    "",
  ].join("\n");
  const lib = "export function helper(): void {}\n";

  it("resolves an arrow closure called after its declaration and inside its own body", async () => {
    const index = await build({ "closures.ts": closures, "lib.ts": lib });
    expect(resolution(index, "closures.ts", 5, "early")).toMatchObject({ status: "resolved", method: "lexical-definition", toSymbol: "closures.ts#outer.early" });
    expect(resolution(index, "closures.ts", 6, "rec")).toMatchObject({ status: "resolved", toSymbol: "closures.ts#outer.rec" });
    expect(resolution(index, "closures.ts", 7, "rec")).toMatchObject({ status: "resolved", toSymbol: "closures.ts#outer.rec" });
  });

  it("leaves a call before the declaration and a call through a shadowing parameter unresolved", async () => {
    const index = await build({ "closures.ts": closures, "lib.ts": lib });
    expect(resolution(index, "closures.ts", 3, "early")).toMatchObject({ status: "unresolved", reason: "binding-blocked", toSymbol: undefined });
    expect(resolution(index, "closures.ts", 9, "shadow")).toMatchObject({ status: "unresolved", reason: "binding-blocked", toSymbol: undefined });
  });

  it("leaves a reassigned closure name unresolved", async () => {
    const index = await build({ "closures.ts": closures, "lib.ts": lib });
    expect(resolution(index, "closures.ts", 13, "re")).toMatchObject({ status: "unresolved", reason: "binding-blocked", toSymbol: undefined });
    expect(resolution(index, "closures.ts", 22, "decl")).toMatchObject({ status: "unresolved", reason: "binding-blocked", toSymbol: undefined });
  });

  it("follows an alias of an import or of a local closure and leaves an alias of a global unresolved", async () => {
    const index = await build({ "closures.ts": closures, "lib.ts": lib });
    expect(resolution(index, "closures.ts", 15, "viaImport")).toMatchObject({ status: "resolved", method: "import-binding", toSymbol: "lib.ts#helper" });
    expect(resolution(index, "closures.ts", 19, "viaLocal")).toMatchObject({ status: "resolved", method: "lexical-definition", toSymbol: "closures.ts#outer.rec" });
    expect(resolution(index, "closures.ts", 17, "viaGlobal")).toMatchObject({ status: "unresolved", reason: "binding-blocked", toSymbol: undefined });
  });

  it("resolves a closure declared inside an object literal method to the symbol the adapter emits", async () => {
    const index = await build({ "closures.ts": closures, "lib.ts": lib });
    expect(index.symbols.get("closures.ts#visit")?.kind).toBe("function");
    expect(resolution(index, "closures.ts", 26, "visit")).toMatchObject({ status: "resolved", method: "lexical-definition", toSymbol: "closures.ts#visit" });
    expect(resolution(index, "closures.ts", 27, "visit")).toMatchObject({ status: "resolved", method: "lexical-definition", toSymbol: "closures.ts#visit" });
  });
});

describe("calls to a nested Python function", () => {
  const closures = [
    /* 1 */ "from lib import helper",
    /* 2 */ "",
    /* 3 */ "def outer():",
    /* 4 */ "    def inner():",
    /* 5 */ "        inner()",
    /* 6 */ "    inner()",
    /* 7 */ "    lam = lambda: 1",
    /* 8 */ "    lam()",
    /* 9 */ "    def shadow():",
    /* 10 */ "        pass",
    /* 11 */ "    def take(shadow):",
    /* 12 */ "        shadow()",
    /* 13 */ "    take(shadow)",
    /* 14 */ "    def re():",
    /* 15 */ "        pass",
    /* 16 */ "    re = helper",
    /* 17 */ "    re()",
    /* 18 */ "    via_import = helper",
    /* 19 */ "    via_import()",
    /* 20 */ "    via_global = len",
    /* 21 */ "    via_global([])",
    /* 22 */ "    via_local = inner",
    /* 23 */ "    via_local()",
    /* 24 */ "",
    /* 25 */ "def make(cls=None):",
    /* 26 */ "    if cls is None:",
    /* 27 */ "        cls = helper",
    /* 28 */ "    return cls()",
    /* 29 */ "",
    /* 30 */ "def forward():",
    /* 31 */ "    fwd = later",
    /* 32 */ "    fwd()",
    /* 33 */ "    def later():",
    /* 34 */ "        pass",
    "",
  ].join("\n");
  const lib = "def helper():\n    pass\n";

  it("resolves a nested def called from the enclosing body and from its own body", async () => {
    const index = await build({ "closures.py": closures, "lib.py": lib });
    expect(resolution(index, "closures.py", 5, "inner")).toMatchObject({ status: "resolved", method: "lexical-definition", toSymbol: "closures.py#outer.inner" });
    expect(resolution(index, "closures.py", 6, "inner")).toMatchObject({ status: "resolved", method: "lexical-definition", toSymbol: "closures.py#outer.inner" });
  });

  it("keeps a lambda, a shadowing parameter and a reassigned def unresolved", async () => {
    const index = await build({ "closures.py": closures, "lib.py": lib });
    expect(resolution(index, "closures.py", 8, "lam")).toMatchObject({ status: "unresolved", reason: "binding-blocked", toSymbol: undefined });
    expect(resolution(index, "closures.py", 12, "shadow")).toMatchObject({ status: "unresolved", reason: "binding-blocked", toSymbol: undefined });
    expect(resolution(index, "closures.py", 17, "re")).toMatchObject({ status: "unresolved", reason: "binding-blocked", toSymbol: undefined });
  });

  it("follows an alias of an import or of a nested def and leaves an alias of a builtin unresolved", async () => {
    const index = await build({ "closures.py": closures, "lib.py": lib });
    expect(resolution(index, "closures.py", 19, "via_import")).toMatchObject({ status: "resolved", method: "import-binding", toSymbol: "lib.py#helper" });
    expect(resolution(index, "closures.py", 23, "via_local")).toMatchObject({ status: "resolved", method: "lexical-definition", toSymbol: "closures.py#outer.inner" });
    expect(resolution(index, "closures.py", 21, "via_global")).toMatchObject({ status: "unresolved", reason: "binding-blocked", toSymbol: undefined });
  });

  it("keeps a parameter unresolved when a default assignment names a function", async () => {
    const index = await build({ "closures.py": closures, "lib.py": lib });
    expect(resolution(index, "closures.py", 28, "cls")).toMatchObject({ status: "unresolved", reason: "binding-blocked", toSymbol: undefined });
  });

  it("prefers a def over a conditional import of the same name and blocks a def a prior assignment rebinds", async () => {
    const index = await build({
      "cond.py": [
        /* 1 */ "import sys",
        /* 2 */ "if sys.platform == \"win32\":",
        /* 3 */ "    from lib import helper as pick",
        /* 4 */ "else:",
        /* 5 */ "    def pick():",
        /* 6 */ "        pass",
        /* 7 */ "pick()",
        /* 8 */ "maybe = None",
        /* 9 */ "def maybe():",
        /* 10 */ "    pass",
        /* 11 */ "maybe()",
        "",
      ].join("\n"),
      "lib.py": lib,
    });
    expect(resolution(index, "cond.py", 7, "pick")).toMatchObject({ status: "resolved", method: "lexical-definition", toSymbol: "cond.py#pick" });
    expect(resolution(index, "cond.py", 11, "maybe")).toMatchObject({ status: "unresolved", reason: "binding-blocked", toSymbol: undefined });
  });

  it("keeps an alias of a def declared later in the same body unresolved", async () => {
    const index = await build({ "closures.py": closures, "lib.py": lib });
    expect(resolution(index, "closures.py", 32, "fwd")).toMatchObject({ status: "unresolved", reason: "binding-blocked", toSymbol: undefined });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";
import { csharpExcludedSpans } from "../src/extract/csharp-recovery.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-csharp-recovery-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
});

afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

async function write(files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await fs.writeFile(path.join(workspace, file), text);
  }
}

type Index = Awaited<ReturnType<typeof buildIndex>>;
const symbolsOf = (index: Index, file: string) =>
  (index.files.get(file)?.symbols ?? []).map((symbol) => `${symbol.kind} ${symbol.qualifiedName.slice(file.length + 1)} ${symbol.span.startLine}-${symbol.span.endLine}`);
const callAt = (index: Index, file: string, line: number, toName: string) =>
  index.edges.filter((edge) => edge.kind === "calls" && edge.fromFile === file && edge.line === line && edge.toName === toName).map((edge) => edge.toSymbol);
const diagnosticsOf = (index: Index) => (index.diagnostics ?? []).map((diagnostic) => `${diagnostic.code}:${diagnostic.path}`);

describe("C# constructs the pinned grammar cannot read", () => {
  it("indexes a type with a primary constructor and the members after it", async () => {
    await write({
      "A.cs": [
        /* 1 */ "partial class A",
        /* 2 */ "{",
        /* 3 */ "    readonly struct Pair(int left, int right) : IComparable<Pair>",
        /* 4 */ "    {",
        /* 5 */ "        public int Left { get; } = left;",
        /* 6 */ "    }",
        /* 7 */ "",
        /* 8 */ "    static bool Helper(int v) => v > 0;",
        /* 9 */ "}",
        "",
      ].join("\n"),
      "A2.cs": "partial class A\n{\n    public bool Run(int x) => Helper(x);\n}\n",
      "B.cs": "static class B\n{\n    public static bool Helper(int v) => v < 0;\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(symbolsOf(index, "A.cs")).toEqual(["class A 1-9", "struct A.Pair 3-6", "method A.Helper 8-8"]);
    expect(index.symbols.get("A.cs#A.Pair")?.signature).toContain("readonly struct Pair(int left, int right)");
    expect(callAt(index, "A2.cs", 3, "Helper")).not.toContain("B.cs#B.Helper");
    expect(diagnosticsOf(index)).toEqual([]);
  });

  it("drops a primary constructor's base arguments but keeps the declaration", async () => {
    await write({
      "C.cs": [
        /* 1 */ "sealed class Child(string name, int size) : Base(name), IDisposable",
        /* 2 */ "{",
        /* 3 */ "    public void Dispose() => Close(size);",
        /* 4 */ "    void Close(int s) { }",
        /* 5 */ "}",
        "",
      ].join("\n"),
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(symbolsOf(index, "C.cs")).toEqual(["class Child 1-5", "method Child.Dispose 3-3", "method Child.Close 4-4"]);
    expect(callAt(index, "C.cs", 3, "Close")).toEqual(["C.cs#Child.Close"]);
  });

  it("reads past raw string literals and keeps calls in simple interpolation holes", async () => {
    await write({
      "T.cs": [
        /*  1 */ "class T",
        /*  2 */ "{",
        /*  3 */ "    const string Yaml = \"\"\"",
        /*  4 */ "        locale: 'zz'",
        /*  5 */ "        quote: \"x\" and \"\"two\"\"",
        /*  6 */ "        \"\"\";",
        /*  7 */ "    string Render(string key) => $$\"\"\"",
        /*  8 */ "        {literal}: {{Quote(key)}}",
        /*  9 */ "        \"\"\";",
        /* 10 */ "    static string Quote(string s) => s;",
        /* 11 */ "    string Single() => \"é\" + \"\"\"one \"line\" here\"\"\" + Quote(\"x\");",
        /* 12 */ "}",
        "",
      ].join("\n"),
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(symbolsOf(index, "T.cs")).toEqual(["class T 1-12", "method T.Render 7-9", "method T.Quote 10-10", "method T.Single 11-11"]);
    expect(callAt(index, "T.cs", 8, "Quote")).toEqual(["T.cs#T.Quote"]);
    expect(callAt(index, "T.cs", 11, "Quote")).toEqual(["T.cs#T.Quote"]);
    expect(diagnosticsOf(index)).toEqual([]);
  });

  it("keeps reporting files whose errors recovery does not remove", async () => {
    await write({
      "Broken.cs": "class Broken(int x)\n{\n    void M( { }\n}\n",
      "Bodiless.cs": "sealed class Context() : Base(collectible: true)\n{\n    protected override int Load(string name) => name.Length;\n}\nsealed class Derived(int size) : Context(size);\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(diagnosticsOf(index)).toEqual(["syntax-errors:Bodiless.cs", "syntax-errors:Broken.cs"]);
    expect(symbolsOf(index, "Bodiless.cs")).toContain("method Context.Load 3-3");
  });
});

describe("csharpExcludedSpans", () => {
  const excluded = (text: string) => csharpExcludedSpans(text).map(([start, end]) => text.slice(start, end));

  it("excludes primary constructor parameters and base arguments only in code", () => {
    expect(excluded("class A<T>(int x) : B<T>(x) { }")).toEqual(["(int x)", "(x)"]);
    expect(excluded("public struct P /* c */ (string s = \")\") { }")).toEqual(["(string s = \")\")"]);
    expect(excluded("record R(int X);\nclass C { }")).toEqual([]);
    expect(excluded("// class A(int x)\nvar s = \"class B(int y)\"; var c = 'c'; var v = @\"class D(\"\" \"\")\";")).toEqual([]);
    expect(excluded("void M<T>() where T : class, new() { }")).toEqual([]);
    expect(excluded("x.class(1)")).toEqual([]);
  });

  it("keeps one quote at each end of a raw string and exposes simple holes", () => {
    expect(excluded("var a = \"\"\"x\"\"\";")).toEqual(["\"\"x\"\""]);
    expect(excluded("var b = $\"\"\"a {F(x)} b\"\"\";")).toEqual(["\"\"a ", " b\"\""]);
    expect(excluded("var c = $$\"\"\"{a} {{F(x)}}\"\"\";")).toEqual(["$", "\"\"{a} {", "}\"\""]);
    expect(excluded("var d = $\"\"\"{F(\"q\")}\"\"\";")).toEqual(["\"\"{F(\"q\")}\"\""]);
    expect(excluded("var e = $\"a {(cond ? \"\"\"x\"\"\" : y)} b\";")).toEqual(["\"\"x\"\""]);
    expect(excluded("class A(int x) { }\nvar f = \"\"\"never closed\nclass B(int y) { }")).toEqual(["(int x)"]);
  });
});

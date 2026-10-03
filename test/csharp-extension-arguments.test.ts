import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyChanges, buildIndex } from "../src/index.js";

// C# extension methods chosen among several candidates by the written types of the call's arguments, as the compiler
// chooses them: each argument must convert implicitly to its parameter, and among the applicable candidates the better
// function member wins. Every pick here is what `dotnet build` binds.

let temporary: string;
let workspace: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-extension-arguments-"));
  workspace = path.join(temporary, "workspace");
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
const build = () => buildIndex(workspace, { cacheDir: path.join(temporary, `cache-${Math.random()}`) });
// The declaration line each call of `name` on `line` of Use.cs binds, or undefined for an unresolved call.
const picks = (index: Index, line: number, name: string): (number | undefined)[] =>
  index.edges.filter((edge) => edge.kind === "calls" && edge.fromFile === "Use.cs" && edge.line === line && edge.toName === name)
    .map((edge) => (edge.toSymbol === undefined ? undefined : edge.overload !== undefined && "line" in edge.overload ? edge.overload.line : -1));

// Overloads shaped like humanizer's: one receiver type, parameters that differ by an enum, a .NET class, a bool and
// defaults.
const words = [
  "using System.Globalization;",
  "namespace Lib;",
  "public enum WordForm { Normal, Abbreviation }",
  "public enum Gender { Masculine, Feminine }",
  "public static class Words",
  "{",
  "    public static string ToWords(this int n, CultureInfo? culture = null) => \"\";",
  "    public static string ToWords(this int n, WordForm form, CultureInfo? culture = null) => \"\";",
  "    public static string ToWords(this int n, bool addAnd, CultureInfo? culture = null) => \"\";",
  "    public static string ToWords(this int n, Gender gender, CultureInfo? culture = null) => \"\";",
  "    public static string ToWords(this int n, WordForm form, Gender gender, CultureInfo? culture = null) => \"\";",
  "}",
  "",
].join("\n");

const use = (body: string[], usings = ["using System.Globalization;", "using Lib;"]) =>
  [...usings, "namespace App;", "public class Use", "{", "    public void Run(CultureInfo culture, WordForm form, Gender gender, bool flag, int number, long big)", "    {", ...body.map((line) => `        ${line}`), "    }", "}", ""].join("\n");

describe("a C# extension method chosen by the written argument types", () => {
  it("picks the overload each argument's written type selects", async () => {
    await write({
      "Words.cs": words,
      "Use.cs": use([
        "5.ToWords();",
        "5.ToWords(culture);",
        "5.ToWords(WordForm.Abbreviation);",
        "5.ToWords(form, culture);",
        "5.ToWords(true);",
        "5.ToWords(gender);",
        "5.ToWords(form, gender);",
        "5.ToWords(null);",
        "5.ToWords(new CultureInfo(\"tr\"));",
        "5.ToWords(form, null);",
      ]),
    });
    const index = await build();
    expect(picks(index, 8, "ToWords")).toEqual([7]);
    expect(picks(index, 9, "ToWords")).toEqual([7]);
    expect(picks(index, 10, "ToWords")).toEqual([8]);
    expect(picks(index, 11, "ToWords")).toEqual([8]);
    expect(picks(index, 12, "ToWords")).toEqual([9]);
    expect(picks(index, 13, "ToWords")).toEqual([10]);
    expect(picks(index, 14, "ToWords")).toEqual([11]);
    // null converts to the nullable class parameter and to no enum or bool.
    expect(picks(index, 15, "ToWords")).toEqual([7]);
    expect(picks(index, 16, "ToWords")).toEqual([7]);
    expect(picks(index, 17, "ToWords")).toEqual([8]);
  });

  it("converts the constant zero to an enum, and no other integer", async () => {
    await write({
      "Words.cs": words,
      "Use.cs": use(["5.ToWords(0);", "5.ToWords(1);", "5.ToWords(0, 0);", "5.ToWords(-1);"]),
    });
    const index = await build();
    // 0 converts to WordForm and to Gender alike: ambiguous, so no claim.
    expect(picks(index, 8, "ToWords")).toEqual([undefined]);
    expect(picks(index, 9, "ToWords")).toEqual([undefined]);
    expect(picks(index, 10, "ToWords")).toEqual([11]);
    expect(picks(index, 11, "ToWords")).toEqual([undefined]);
  });

  it("applies numeric widening and constant conversions, and prefers the exact or narrower target", async () => {
    await write({
      "Ext.cs": "namespace Lib;\npublic static class Ext\n{\n    public static void Grab(this string s, long n) { }\n    public static void Grab(this string s, byte n) { }\n    public static void Wide(this string s, long n) { }\n    public static void Wide(this string s, double d) { }\n    public static void Only(this string s, int n) { }\n    public static void Only(this string s, bool b) { }\n}\n",
      "Use.cs": use(["\"x\".Grab(number);", "\"x\".Grab(3);", "\"x\".Grab(300);", "\"x\".Grab(big);", "\"x\".Wide(number);", "\"x\".Only(big);", "\"x\".Only('c');"], ["using Lib;"]),
    });
    const index = await build();
    // An int variable converts to long, not to byte.
    expect(picks(index, 7, "Grab")).toEqual([4]);
    // The constant 3 converts to both; byte is the better target since byte converts to long.
    expect(picks(index, 8, "Grab")).toEqual([5]);
    expect(picks(index, 9, "Grab")).toEqual([4]);
    expect(picks(index, 10, "Grab")).toEqual([4]);
    // int converts to long and to double; long is better since long converts to double.
    expect(picks(index, 11, "Wide")).toEqual([6]);
    // long converts to neither int nor bool.
    expect(picks(index, 12, "Only")).toEqual([undefined]);
    // char converts to int.
    expect(picks(index, 13, "Only")).toEqual([8]);
  });

  it("reads a .NET type through the file's usings, and leaves an ambiguous or aliased name unknown", async () => {
    const ext = "namespace Lib;\npublic enum WordForm { Normal }\npublic static class Ext\n{\n    public static void Go(this string s, WordForm f) { }\n    public static void Go(this string s, System.Globalization.CultureInfo c) { }\n}\n";
    await write({
      "Ext.cs": ext,
      "Use.cs": "using Lib;\nusing System.Globalization;\nnamespace App;\npublic class Use\n{\n    public void Run(CultureInfo culture, StringBuilder sb) { \"x\".Go(culture); }\n}\n",
    });
    expect(picks(await build(), 6, "Go")).toEqual([6]);
    // Without the using, CultureInfo is no .NET type the file sees, so its kind is unknown.
    await write({ "Use.cs": "using Lib;\nnamespace App;\npublic class Use\n{\n    public void Run(CultureInfo culture) { \"x\".Go(culture); }\n}\n" });
    expect(picks(await build(), 5, "Go")).toEqual([undefined]);
    // Timer is in two imported .NET namespaces: the compiler reports an ambiguity, and the index claims nothing.
    await write({
      "Ext.cs": "namespace Lib;\npublic enum WordForm { Normal }\npublic static class Ext\n{\n    public static void Go(this string s, WordForm f) { }\n    public static void Go(this string s, System.Threading.Timer t) { }\n}\n",
      "Use.cs": "using Lib;\nusing System.Threading;\nusing System.Timers;\nnamespace App;\npublic class Use\n{\n    public void Run(Timer t) { \"x\".Go(t); }\n}\n",
    });
    expect(picks(await build(), 7, "Go")).toEqual([undefined]);
    // An alias of the name, anywhere in the index, may be what it means.
    await write({
      "Ext.cs": ext,
      "Other.cs": "using CultureInfo = Lib.WordForm;\nnamespace Elsewhere;\npublic class Other { }\n",
      "Use.cs": "using Lib;\nusing System.Globalization;\nnamespace App;\npublic class Use\n{\n    public void Run(CultureInfo culture) { \"x\".Go(culture); }\n}\n",
    });
    expect(picks(await build(), 6, "Go")).toEqual([undefined]);
  });

  it("merges a namespace the index declares with .NET's of the same name", async () => {
    await write({
      "Polyfill.cs": "namespace System.Runtime.CompilerServices;\ninternal static class IsExternalInit { }\n",
      "Ext.cs": "namespace Lib;\npublic enum WordForm { Normal }\npublic static class Ext\n{\n    public static void Go(this string s, WordForm f) { }\n    public static void Go(this string s, System.Globalization.CultureInfo c) { }\n}\n",
      "Use.cs": "using Lib;\nnamespace App;\npublic class Use\n{\n    public void Run() { \"x\".Go(new System.Globalization.CultureInfo(\"tr\")); }\n}\n",
    });
    expect(picks(await build(), 5, "Go")).toEqual([6]);
  });

  it("requires a ref or out argument for a ref or out parameter, and reads no ref argument", async () => {
    await write({
      "Ext.cs": "namespace Lib;\npublic static class Ext\n{\n    public static void Go(this string s, ref int n) { }\n    public static void Go(this string s, long n) { }\n    public static void In(this string s, in int n) { }\n    public static void In(this string s, long n) { }\n}\n",
      "Use.cs": use(["\"x\".Go(number);", "\"x\".Go(ref number);", "\"x\".In(number);"], ["using Lib;"]),
    });
    const index = await build();
    // Without `ref`, only the long overload applies.
    expect(picks(index, 7, "Go")).toEqual([5]);
    expect(picks(index, 8, "Go")).toEqual([undefined]);
    // An `in` parameter takes a value argument; int is the exact match.
    expect(picks(index, 9, "In")).toEqual([6]);
  });

  it("claims nothing for params, named arguments, generic methods or an unknown argument", async () => {
    await write({
      "Ext.cs": "namespace Lib;\npublic enum WordForm { Normal }\npublic static class Ext\n{\n    public static void P(this string s, WordForm f) { }\n    public static void P(this string s, params object[] rest) { }\n    public static void N(this string s, WordForm f, int n = 0) { }\n    public static void N(this string s, int n, int m = 0) { }\n    public static void G(this string s, WordForm f) { }\n    public static void G<T>(this string s, T value) { }\n    public static void U(this string s, WordForm f) { }\n    public static void U(this string s, int n) { }\n}\n",
      "Use.cs": use(["\"x\".P(form);", "\"x\".N(n: 1);", "\"x\".N(f: form);", "\"x\".G(form);", "var v = Make(); \"x\".U(v);", "\"x\".U(number.GetHashCode());"], ["using Lib;"]),
    });
    const index = await build();
    expect(picks(index, 7, "P")).toEqual([undefined]);
    expect(picks(index, 8, "N")).toEqual([undefined]);
    expect(picks(index, 9, "N")).toEqual([undefined]);
    expect(picks(index, 10, "G")).toEqual([undefined]);
    expect(picks(index, 11, "U")).toEqual([undefined]);
    expect(picks(index, 12, "U")).toEqual([undefined]);
  });

  it("leaves a conversion open where a type declares an implicit operator", async () => {
    await write({
      "Ext.cs": "namespace Lib;\npublic enum WordForm { Normal }\npublic struct Money { public static implicit operator Money(int v) => default; }\npublic class Base { public static implicit operator Base(int v) => new(); }\npublic class Derived : Base { }\npublic static class Ext\n{\n    public static void Pay(this string s, Money m) { }\n    public static void Pay(this string s, long n) { }\n    public static void Inherit(this string s, Derived d) { }\n    public static void Inherit(this string s, long n) { }\n    public static void Plain(this string s, WordForm f) { }\n    public static void Plain(this string s, long n) { }\n}\n",
      "Use.cs": use(["\"x\".Pay(number);", "\"x\".Inherit(number);", "\"x\".Plain(number);"], ["using Lib;"]),
    });
    const index = await build();
    // int may convert to Money through its operator, so the choice is not the index's to make.
    expect(picks(index, 7, "Pay")).toEqual([undefined]);
    // A base class's operator counts for a derived parameter type too.
    expect(picks(index, 8, "Inherit")).toEqual([undefined]);
    // An enum declares no operator: int converts to long only.
    expect(picks(index, 9, "Plain")).toEqual([13]);
  });

  it("types a negated literal as the compiler does", async () => {
    await write({
      "Ext.cs": "namespace Lib;\npublic static class Ext\n{\n    public static void A(this string s, int n) { }\n    public static void A(this string s, long n) { }\n    public static void B(this string s, uint n) { }\n    public static void B(this string s, long n) { }\n    public static void C(this string s, long n) { }\n    public static void C(this string s, object n) { }\n}\n",
      "Use.cs": use(["\"x\".A(-2147483648);", "\"x\".B(-1u);", "\"x\".B(-2147483648u);", "\"x\".C(-9223372036854775808);", "\"x\".A(-(1));"], ["using Lib;"]),
    });
    const index = await build();
    // -2147483648 is int.MinValue; a negated uint is long; -9223372036854775808 is long.MinValue.
    expect(picks(index, 7, "A")).toEqual([4]);
    expect(picks(index, 8, "B")).toEqual([7]);
    expect(picks(index, 9, "B")).toEqual([7]);
    expect(picks(index, 10, "C")).toEqual([8]);
    expect(picks(index, 11, "A")).toEqual([4]);
  });

  it("keeps constant conversions for parenthesized, cast, default and const operands", async () => {
    await write({
      "Ext.cs": "namespace Lib;\npublic enum E { Zero }\npublic static class Ext\n{\n    public static void P(this string s, byte n) { }\n    public static void P(this string s, long n) { }\n    public static void Z(this string s, E e) { }\n    public static void Z(this string s, object o) { }\n}\n",
      "Use.cs": "using Lib;\nnamespace App;\npublic class Use\n{\n    const int N = 1;\n    public void Run()\n    {\n        const int n = 1; const int zero = 0;\n        \"x\".P((1));\n        \"x\".P(((255)));\n        \"x\".P((int)1);\n        \"x\".P((byte)1);\n        \"x\".P(n);\n        \"x\".P(N);\n        \"x\".Z(zero);\n        \"x\".Z(default(int));\n        \"x\".Z((0));\n        \"x\".Z(1);\n    }\n}\n",
    });
    const index = await build();
    expect(picks(index, 9, "P")).toEqual([5]);
    expect(picks(index, 10, "P")).toEqual([5]);
    expect(picks(index, 11, "P")).toEqual([5]);
    // A byte constant converts to byte (identity) and to long; its other constant conversions are not read: unresolved.
    expect(picks(index, 12, "P")).toEqual([undefined]);
    // A const name is a constant whose value is not read.
    expect(picks(index, 13, "P")).toEqual([undefined]);
    expect(picks(index, 14, "P")).toEqual([undefined]);
    expect(picks(index, 15, "Z")).toEqual([undefined]);
    expect(picks(index, 16, "Z")).toEqual([7]);
    expect(picks(index, 17, "Z")).toEqual([7]);
    // 1 converts to object only.
    expect(picks(index, 18, "Z")).toEqual([8]);
  });

  it("finds a .NET type of an enclosing namespace before an indexed type imported further out", async () => {
    await write({
      "Repo.cs": "namespace Repo;\npublic class DateTime { }\n",
      "Ext.cs": "using Repo;\nnamespace System.Review;\npublic static class Ext\n{\n    public static string Pick(this string s, System.DateTime n) => \"dotnet\";\n    public static string Pick(this string s, Repo.DateTime n) => \"repo\";\n}\npublic class Use\n{\n    public string Run() { DateTime n = default; return \"s\".Pick(n); }\n}\n",
    });
    const index = await build();
    const edge = index.edges.find((e) => e.kind === "calls" && e.fromFile === "Ext.cs" && e.toName === "Pick");
    expect(edge?.overload).toEqual({ line: 5, types: true });
  });

  it("does not read a type parameter's static member as an enum member", async () => {
    await write({
      "Ext.cs": "namespace Lib;\npublic enum T { M }\npublic interface IHasM { static abstract int M { get; } }\npublic static class Ext\n{\n    public static string Pick(this string s, T n) => \"enum\";\n    public static string Pick(this string s, int n) => \"int\";\n}\npublic static class Use\n{\n    public static string Run<T>() where T : IHasM => \"s\".Pick(T.M);\n}\n",
    });
    const index = await build();
    const edge = index.edges.find((e) => e.kind === "calls" && e.toName === "Pick");
    expect(edge?.toSymbol).toBeUndefined();
  });

  it("gives an incremental update the same picks as a full rebuild", async () => {
    await write({ "Words.cs": words, "Use.cs": use(["5.ToWords(form);", "5.ToWords(culture);"]) });
    const cacheDir = path.join(temporary, "cache");
    const first = await buildIndex(workspace, { cacheDir });
    expect(picks(first, 8, "ToWords")).toEqual([8]);
    await write({ "Words.cs": words.replace("WordForm form, CultureInfo? culture = null)", "WordForm form, Gender gender)") });
    const updated = await applyChanges(first, workspace, ["Words.cs"]);
    const rebuilt = await buildIndex(workspace, { cacheDir: path.join(temporary, "cache-2") });
    // The one-argument form call now fits no overload: WordForm converts to neither CultureInfo, bool nor Gender.
    expect(picks(updated, 8, "ToWords")).toEqual([undefined]);
    expect(picks(updated, 9, "ToWords")).toEqual([7]);
    expect(picks(updated, 8, "ToWords")).toEqual(picks(rebuilt, 8, "ToWords"));
    expect(picks(updated, 9, "ToWords")).toEqual(picks(rebuilt, 9, "ToWords"));
  });
});

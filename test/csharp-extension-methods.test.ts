import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyChanges, buildIndex, loadIndex, serializeArtifact } from "../src/index.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-extensions-"));
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
const callsAt = (index: Index, file: string, line: number, name: string) =>
  index.edges.filter((edge) => edge.kind === "calls" && edge.fromFile === file && edge.line === line && edge.toName === name)
    .map((edge) => ({ toSymbol: edge.toSymbol, ...(edge.overload === undefined ? {} : { overload: edge.overload }) }));

const extensions = [
  "namespace Lib;",
  "public struct Size { }",
  "public static class SizeExtensions",
  "{",
  "    public static Size Bytes(this int value) => default;",
  "    public static Size Bytes(this long value) => default;",
  "    public static string Humanize(this System.DateTime value) => \"\";",
  "    public static string Humanize(this System.DateTime? value) => \"\";",
  "    public static T Echo<T>(this T value) => value;",
  "}",
  "",
].join("\n");

describe("a C# extension method chosen by the receiver's written type", () => {
  it("names the overload an int, a long, a DateTime and a nullable DateTime receiver selects", async () => {
    await write({
      "Lib/SizeExtensions.cs": extensions,
      "App/Use.cs": [
        "using System;",
        "using Lib;",
        "namespace App;",
        "public class Use",
        "{",
        "    public void Run(DateTime when, DateTime? maybe)",
        "    {",
        "        var a = 5.Bytes();",
        "        var b = 5L.Bytes();",
        "        var c = when.Humanize();",
        "        var d = maybe.Humanize();",
        "        var e = \"x\".Echo();",
        "    }",
        "}",
        "",
      ].join("\n"),
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(callsAt(index, "App/Use.cs", 8, "Bytes")).toEqual([{ toSymbol: "Lib/SizeExtensions.cs#SizeExtensions.Bytes", overload: { line: 5, types: true } }]);
    expect(callsAt(index, "App/Use.cs", 9, "Bytes")).toEqual([{ toSymbol: "Lib/SizeExtensions.cs#SizeExtensions.Bytes", overload: { line: 6, types: true } }]);
    expect(callsAt(index, "App/Use.cs", 10, "Humanize")).toEqual([{ toSymbol: "Lib/SizeExtensions.cs#SizeExtensions.Humanize", overload: { line: 7, types: true } }]);
    expect(callsAt(index, "App/Use.cs", 11, "Humanize")).toEqual([{ toSymbol: "Lib/SizeExtensions.cs#SizeExtensions.Humanize", overload: { line: 8, types: true } }]);
    // A generic `this T` is the only candidate of its name, so it is the one the compiler binds.
    expect(callsAt(index, "App/Use.cs", 12, "Echo")).toEqual([{ toSymbol: "Lib/SizeExtensions.cs#SizeExtensions.Echo" }]);
  });

  it("leaves a call to a member of the receiver's type, or of a base class, to member lookup", async () => {
    await write({
      "Lib/Ext.cs": "namespace Lib;\npublic static class Ext\n{\n    public static void Go(this Lib.Derived d) { }\n    public static void Count(this Lib.Derived d) { }\n}\n",
      "Lib/Types.cs": "namespace Lib;\npublic class Base\n{\n    public void Go() { }\n}\npublic class Derived : Base\n{\n    public int Count { get; set; }\n}\n",
      "Lib/Use.cs": "namespace Lib;\npublic class Use\n{\n    public void Run()\n    {\n        new Derived().Go();\n        new Derived().Count();\n    }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(callsAt(index, "Lib/Use.cs", 6, "Go").map((call) => call.toSymbol)).not.toContain("Lib/Ext.cs#Ext.Go");
    expect(callsAt(index, "Lib/Use.cs", 7, "Count").map((call) => call.toSymbol)).toEqual([undefined]);
  });

  it("takes the innermost namespace level that has a candidate", async () => {
    await write({
      "Outer/Ext.cs": "namespace Outer;\npublic static class OuterExt\n{\n    public static void Tag(this string s) { }\n}\n",
      "App/Ext.cs": "namespace App.Inner;\npublic static class InnerExt\n{\n    public static void Tag(this string s) { }\n}\n",
      "App/Use.cs": "using Outer;\nnamespace App.Inner\n{\n    public class Use\n    {\n        public void Run() { \"x\".Tag(); }\n    }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(callsAt(index, "App/Use.cs", 6, "Tag")).toEqual([{ toSymbol: "App/Ext.cs#InnerExt.Tag" }]);
  });

  it("does not choose between two candidates at one level that both take the receiver", async () => {
    await write({
      "Lib/Ext.cs": "namespace Lib;\npublic static class Ext\n{\n    public static void Show(this string s) { }\n    public static void Show(this object o) { }\n}\n",
      "Lib/Use.cs": "namespace Lib;\npublic class Use\n{\n    public void Run() { \"x\".Show(); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(callsAt(index, "Lib/Use.cs", 4, "Show")).toEqual([{ toSymbol: undefined }]);
  });

  it("follows the receiver's class chain to the this parameter's class", async () => {
    await write({
      "Lib/Ext.cs": "namespace Lib;\npublic static class Ext\n{\n    public static void Visit(this Lib.Base b) { }\n    public static void Visit(this string s) { }\n}\n",
      "Lib/Types.cs": "namespace Lib;\npublic class Base { }\npublic class Derived : Base { }\n",
      "Lib/Use.cs": "namespace Lib;\npublic class Use\n{\n    public void Run(Derived d) { d.Visit(); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(callsAt(index, "Lib/Use.cs", 4, "Visit")).toEqual([{ toSymbol: "Lib/Ext.cs#Ext.Visit", overload: { line: 4, types: true } }]);
  });

  it("does not choose when a .NET namespace imported at the same level declares an extension method of the name", async () => {
    await write({
      "Lib/Ext.cs": "namespace Lib;\npublic static class Ext\n{\n    public static string Reverse(this string s) => s;\n}\n",
      // At the compilation unit, `using Lib;` meets the SDK's implicit `using System.Linq;`, whose Enumerable.Reverse may compete.
      "App/Use.cs": "using Lib;\nnamespace App;\npublic class Use\n{\n    public void Run() { \"ab\".Reverse(); }\n}\n",
      // Inside namespace Lib, the level that declares Ext comes first and binds before System.Linq is searched.
      "Lib/Use.cs": "namespace Lib;\npublic class Use\n{\n    public void Run() { \"ab\".Reverse(); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(callsAt(index, "App/Use.cs", 5, "Reverse")).toEqual([{ toSymbol: undefined }]);
    expect(callsAt(index, "Lib/Use.cs", 4, "Reverse")).toEqual([{ toSymbol: "Lib/Ext.cs#Ext.Reverse" }]);
  });

  it("does not choose a name an extension block the grammar cannot read may declare", async () => {
    await write({
      "Lib/Ext.cs": "namespace Lib;\npublic static class Ext\n{\n    public static int Twice(this string s) => 2;\n}\n",
      "Lib/Block.cs": "namespace Lib;\npublic static class Block\n{\n    extension(string s)\n    {\n        public int Twice() => s.Length * 2;\n    }\n}\n",
      "Lib/Use.cs": "namespace Lib;\npublic class Use\n{\n    public void Run() { \"ab\".Twice(); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(index.files.get("Lib/Block.cs")?.unplacedExtensions).toContain("Twice");
    expect(callsAt(index, "Lib/Use.cs", 4, "Twice")).toEqual([{ toSymbol: undefined }]);
  });

  it("survives a save and load, and an incremental update equals a full rebuild", async () => {
    await write({
      "Lib/SizeExtensions.cs": extensions,
      "App/Use.cs": "using Lib;\nnamespace App;\npublic class Use\n{\n    public void Run() { var a = 5.Bytes(); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    const loaded = await loadIndex(workspace, { cacheDir });
    expect(loaded).toBeDefined();
    expect(serializeArtifact(loaded!).equals(serializeArtifact(index))).toBe(true);
    await fs.writeFile(path.join(workspace, "Lib/SizeExtensions.cs"), extensions.replace("Bytes(this int value)", "Bytes(this short value)"));
    const changed = await applyChanges(index, workspace, ["Lib/SizeExtensions.cs"]);
    const full = await buildIndex(workspace, { cacheDir: path.join(temporary, "full") });
    expect(serializeArtifact(changed).equals(serializeArtifact(full))).toBe(true);
    expect(callsAt(full, "App/Use.cs", 5, "Bytes")).toEqual([{ toSymbol: undefined }]);
  });
});

describe("a C# extension method the compiler would not bind is not chosen", () => {
  const twoLevels = (inner: string, outer: string, call: string, extra = "") => [
    "using Outer;",
    "namespace Outer {",
    "    public static class OuterExt {",
    `        ${outer}`,
    "    }",
    "}",
    "namespace Inner {",
    extra,
    "    public static class InnerExt {",
    `        ${inner}`,
    "    }",
    "    public class Use {",
    `        public static object Run(E? e) => ${call};`,
    "    }",
    "    public enum E { A }",
    "}",
    "",
  ].join("\n");
  const targetAt = (index: Index, name: string) => index.edges.filter((edge) => edge.kind === "calls" && edge.fromFile === "P.cs" && edge.line === 13 && edge.toName === name).map((edge) => edge.toSymbol);

  it("does not take an inner candidate whose other arguments, type inference, constraints or names may not fit", async () => {
    for (const [inner, outer, call] of [
      ["public static string Probe(this string s, int x) => \"inner\";", "public static string Probe(this string s, string x) => \"outer\";", "\"s\".Probe(\"x\")"],
      ["public static string Probe<T>(this string s) => \"inner\";", "public static string Probe(this string s) => \"outer\";", "\"s\".Probe()"],
      ["public static string Probe<T>(this string s, T x) where T : struct => \"inner\";", "public static string Probe(this string s, string x) => \"outer\";", "\"s\".Probe(\"x\")"],
      ["public static string Probe(this string s, int a = 0) => \"inner\";", "public static string Probe(this string s, int b = 0) => \"outer\";", "\"s\".Probe(b: 1)"],
    ]) {
      await write({ "P.cs": twoLevels(inner!, outer!, call!) });
      const index = await buildIndex(workspace, { cacheDir: path.join(temporary, `cache-${Math.random()}`) });
      expect(targetAt(index, "Probe")).toEqual([undefined]);
    }
  });

  it("counts a method offered again by an outer using as no new choice", async () => {
    await write({
      "Lib/Ext.cs": "namespace Lib;\npublic static class Ext\n{\n    public static string Cut(this string s, int length) => s;\n}\n",
      // Inside Lib.Tests, namespace Lib's own level offers Ext.Cut, and `using Lib;` offers it again at the compilation unit.
      "Lib/Tests/Use.cs": "using Lib;\nnamespace Lib.Tests;\npublic class Use\n{\n    public string Run() => \"abc\".Cut(2);\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(index.edges.find((edge) => edge.kind === "calls" && edge.toName === "Cut")?.toSymbol).toBe("Lib/Ext.cs#Ext.Cut");
  });

  it("skips a private extension method outside its class", async () => {
    await write({ "P.cs": twoLevels("private static string Probe(this string s) => \"inner\";", "public static string Probe(this string s) => \"outer\";", "\"s\".Probe()") });
    const index = await buildIndex(workspace, { cacheDir });
    expect(targetAt(index, "Probe")).toEqual(["P.cs#OuterExt.Probe"]);
  });

  it("lets another partial declaration of the class call its private extension method", async () => {
    await write({
      "Ext.cs": "namespace Inner;\npublic static partial class Ext {\n    private static string Probe(this string s) => \"inner\";\n}\n",
      "Outer.cs": "namespace Outer;\npublic static class OuterExt {\n    public static string Probe(this string s) => \"outer\";\n}\n",
      "Program.cs": "using Outer;\nnamespace Inner;\npublic static partial class Ext {\n    public static string Run() => \"s\".Probe();\n    public class Nested { public static string Go() => \"s\".Probe(); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    for (const line of [4, 5]) expect(index.edges.find((edge) => edge.kind === "calls" && edge.fromFile === "Program.cs" && edge.line === line && edge.toName === "Probe")?.toSymbol).toBe("Ext.cs#Ext.Probe");
  });

  it("leaves a delegate's own members to member lookup", async () => {
    await write({ "P.cs": "namespace Inner {\n    public delegate void D();\n    public static class InnerExt {\n        public static void Invoke(this D d) { }\n        public static int GetInvocationList(this D d) => 0;\n    }\n    public class Use {\n        public static void Run(D d) { d.Invoke(); d.GetInvocationList(); }\n    }\n}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    for (const name of ["Invoke", "GetInvocationList"]) expect(index.edges.find((edge) => edge.kind === "calls" && edge.toName === name)?.toSymbol).toBeUndefined();
  });

  it("does not box a ref struct receiver to object or ValueType", async () => {
    for (const inner of ["object", "System.ValueType"]) {
      await write({ "P.cs": `using Outer;\nnamespace Outer {\n    public static class OuterExt {\n        public static string Probe(this Inner.R r) => "outer";\n    }\n}\nnamespace Inner {\n    public ref struct R { }\n    public static class InnerExt {\n        public static string Probe(this ${inner} r) => "inner";\n    }\n    public class Use {\n        public static string Run() { R r = new R(); return r.Probe(); }\n    }\n}\n` });
      const index = await buildIndex(workspace, { cacheDir: path.join(temporary, `cache-${inner}`) });
      expect(index.edges.find((edge) => edge.kind === "calls" && edge.toName === "Probe")?.toSymbol).toBe("P.cs#OuterExt.Probe");
    }
  });

  it("does not take an extension method inside an #if region", async () => {
    await write({ "P.cs": twoLevels("#if NEVER\n        public static string Probe(this string s) => \"inner\";\n#endif", "public static string Probe(this string s) => \"outer\";", "\"s\".Probe()").replace("public static object Run", "public static object Run") });
    const index = await buildIndex(workspace, { cacheDir });
    const line = index.edges.find((edge) => edge.kind === "calls" && edge.toName === "Probe" && edge.fromFile === "P.cs");
    expect(line?.toSymbol).toBeUndefined();
  });

  it("boxes a nullable enum to System.Enum", async () => {
    await write({ "P.cs": twoLevels("public static string Probe(this System.Enum s) => \"inner\";", "public static string Probe(this object s) => \"outer\";", "e.Probe()") });
    const index = await buildIndex(workspace, { cacheDir });
    expect(targetAt(index, "Probe")).toEqual(["P.cs#InnerExt.Probe"]);
  });

  it("leaves a record struct's synthesized Deconstruct to member lookup", async () => {
    await write({ "P.cs": "namespace Inner {\n    public record struct R(int X);\n    public static class InnerExt {\n        public static void Deconstruct(this R r, out int x) { x = 99; }\n    }\n    public class Use {\n        public static void Run() { new R(1).Deconstruct(out var x); }\n    }\n}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    const call = index.edges.find((edge) => edge.kind === "calls" && edge.toName === "Deconstruct");
    expect(call?.toSymbol).not.toBe("P.cs#InnerExt.Deconstruct");
  });

  it("indexes a receiver type nested deeper than the metadata holds", async () => {
    const type = "Box<".repeat(17) + "int" + ">".repeat(17);
    await write({ "P.cs": `public class Box<T> {}\npublic class Use { public void Run(${type} x) { x.ToString(); } }\n` });
    const index = await buildIndex(workspace, { cacheDir });
    expect(index.edges.find((edge) => edge.kind === "calls" && edge.toName === "ToString")?.argumentTypes).toBeUndefined();
  });
});

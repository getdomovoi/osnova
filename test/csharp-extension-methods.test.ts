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

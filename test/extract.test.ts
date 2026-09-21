import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { callers, callersDetailed } from "../src/query/callers.js";
import { formatCallers, formatCallersDetailed } from "../src/query/format.js";
import type { OsnovaIndex } from "../src/types.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-repo");

let index: OsnovaIndex;

beforeAll(async () => {
  index = await buildIndex(FIXTURE);
});

function symbolsOf(file: string): string[] {
  const card = index.files.get(file);
  expect(card, file).toBeDefined();
  return (card?.symbols ?? []).map((s) => `${s.kind}:${s.qualifiedName}`);
}

describe("extraction adapters", () => {
  it("extracts typescript defs and edges", () => {
    expect(symbolsOf("src/util.ts")).toEqual([
      "constant:src/util.ts#MAX_RETRIES",
      "interface:src/util.ts#RetryOptions",
      "class:src/util.ts#RetryTimer",
      "method:src/util.ts#RetryTimer.tick",
      "function:src/util.ts#pad",
      "function:src/util.ts#formatRetry",
      "function:src/util.ts#internalHelper",
      "function:src/util.ts#compute",
    ]);
    const out = index.outgoing("src/util.ts#compute");
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("calls");
    expect(out[0]?.toSymbol).toBe("src/util.ts#internalHelper");
  });

  it("resolves relative imports and cross-file calls in typescript", () => {
    const imports = index.edges.filter(
      (e) => e.fromFile === "src/app.ts" && e.kind === "imports",
    );
    expect(imports).toHaveLength(1);
    expect(imports[0]?.toFile).toBe("src/util.ts");
    const runCalls = index.outgoing("src/app.ts#run").map((e) => e.toSymbol);
    expect(runCalls).toContain("src/util.ts#pad");
    expect(runCalls).toContain("src/util.ts#compute");
    expect(runCalls).toContain("src/util.ts#RetryTimer.tick");
  });

  it("extracts python classes, methods and constants", () => {
    expect(symbolsOf("src/server.py")).toEqual([
      "constant:src/server.py#MAX_CONNECTIONS",
      "class:src/server.py#Server",
      "method:src/server.py#Server.__init__",
      "method:src/server.py#Server.start",
      "method:src/server.py#Server._listen",
      "function:src/server.py#helper",
      "function:src/server.py#main",
    ]);
    const mainCalls = index.outgoing("src/server.py#main").map((e) => e.toSymbol);
    expect(mainCalls).toContain("src/server.py#Server");
    expect(mainCalls).toContain("src/server.py#Server.start");
    expect(mainCalls).toContain("src/server.py#helper");
  });

  it("extracts go methods with receivers", () => {
    expect(symbolsOf("src/main.go")).toEqual([
      "constant:src/main.go#MaxPorts",
      "struct:src/main.go#Server",
      "method:src/main.go#Server.Start",
      "function:src/main.go#buildServer",
      "function:src/main.go#main",
    ]);
    const imports = index.edges.filter(
      (e) => e.fromFile === "src/main.go" && e.kind === "imports",
    );
    expect(imports[0]?.toName).toBe("fmt");
    const mainCalls = index.outgoing("src/main.go#main").map((e) => e.toSymbol);
    expect(mainCalls).toContain("src/main.go#buildServer");
    expect(mainCalls).toContain("src/main.go#Server.Start");
  });

  it("extracts rust impl methods", () => {
    expect(symbolsOf("src/lib.rs")).toEqual([
      "constant:src/lib.rs#VERSION",
      "struct:src/lib.rs#Config",
      "method:src/lib.rs#Config.new",
      "method:src/lib.rs#Config.describe",
      "function:src/lib.rs#build_config",
    ]);
    const calls = index.outgoing("src/lib.rs#build_config").map((e) => e.toSymbol);
    expect(calls).toContain("src/lib.rs#Config.new");
  });

  it("extracts java classes and methods", () => {
    expect(symbolsOf("src/App.java")).toEqual([
      "class:src/App.java#App",
      "constant:src/App.java#App.MAX_ITEMS",
      "method:src/App.java#App.start",
      "method:src/App.java#App.describe",
    ]);
    const startCalls = index.outgoing("src/App.java#App.start").map((e) => e.toSymbol);
    expect(startCalls).toContain("src/App.java#App.describe");
  });

  it("extracts c# classes and methods", () => {
    expect(symbolsOf("src/Program.cs")).toEqual([
      "class:src/Program.cs#Program",
      "method:src/Program.cs#Program.Start",
      "method:src/Program.cs#Program.Describe",
    ]);
    const startCalls = index.outgoing("src/Program.cs#Program.Start").map((e) => e.toSymbol);
    expect(startCalls).toContain("src/Program.cs#Program.Describe");
  });

  it("extracts c definitions and calls through the generic tier", () => {
    expect(symbolsOf("src/breadth/util.c")).toEqual([
      "struct:src/breadth/util.c#Point",
      "enum:src/breadth/util.c#Mode",
      "function:src/breadth/util.c#helper",
      "function:src/breadth/util.c#compute",
      "function:src/breadth/util.c#make",
    ]);
    const calls = index.outgoing("src/breadth/util.c#compute");
    expect(calls.map((e) => e.toName).sort()).toEqual(["helper", "printf"]);
    expect(calls.find((e) => e.toName === "helper")?.toSymbol).toBe("src/breadth/util.c#helper");
    expect(calls.find((e) => e.toName === "printf")?.evidence).toMatchObject({ source: "syntax", resolution: { status: "unresolved" } });
  });

  it("extracts cpp definitions and calls through the generic tier", () => {
    expect(symbolsOf("src/breadth/shape.cpp")).toEqual([
      "module:src/breadth/shape.cpp#geo",
      "class:src/breadth/shape.cpp#geo.Shape",
      "method:src/breadth/shape.cpp#geo.Shape.area",
      "function:src/breadth/shape.cpp#describe",
      "function:src/breadth/shape.cpp#pick",
    ]);
    expect(index.outgoing("src/breadth/shape.cpp#describe").map((e) => e.toName)).toContain("area");
  });

  it("extracts objective-c definitions and calls through the generic tier", () => {
    expect(symbolsOf("src/breadth/greeter.m")).toEqual([
      "type:src/breadth/greeter.m#Point",
      "enum:src/breadth/greeter.m#Mode",
      "interface:src/breadth/greeter.m#Named",
      "method:src/breadth/greeter.m#Named.name",
      "class:src/breadth/greeter.m#Greeter",
      "method:src/breadth/greeter.m#Greeter.greet",
      "method:src/breadth/greeter.m#Greeter.formatName",
      "method:src/breadth/greeter.m#Greeter.shared",
      "method:src/breadth/greeter.m#Greeter.name",
      "function:src/breadth/greeter.m#helper",
      "function:src/breadth/greeter.m#run",
    ]);
    expect(index.symbols.get("src/breadth/greeter.m#Greeter")?.span.startLine).toBe(18);
    expect(index.outgoing("src/breadth/greeter.m#Greeter.greet").map((e) => e.toName)).toEqual(["formatName"]);
    expect(index.outgoing("src/breadth/greeter.m#Greeter.formatName").map((e) => e.toName)).toEqual(["stringWithFormat", "uppercaseString"]);
    expect(index.outgoing("src/breadth/greeter.m#Greeter.shared").map((e) => e.toName)).toEqual(["alloc", "init"]);
    const runCalls = index.outgoing("src/breadth/greeter.m#run");
    expect(runCalls.map((e) => e.toName)).toEqual(["shared", "NSLog", "greet", "helper"]);
    expect(runCalls.find((e) => e.toName === "helper")?.toSymbol).toBe("src/breadth/greeter.m#helper");
    expect(runCalls.find((e) => e.toName === "greet")?.toSymbol).toBe("src/breadth/greeter.m#Greeter.greet");
  });

  it("extracts ruby definitions and calls through the generic tier", () => {
    expect(symbolsOf("src/breadth/greeter.rb")).toEqual([
      "module:src/breadth/greeter.rb#Greeting",
      "class:src/breadth/greeter.rb#Greeting.Greeter",
      "method:src/breadth/greeter.rb#Greeting.Greeter.greet",
      "method:src/breadth/greeter.rb#Greeting.Greeter.format_name",
      "function:src/breadth/greeter.rb#run",
      "module:src/breadth/greeter.rb#Util",
      "method:src/breadth/greeter.rb#Util.helper",
    ]);
    expect(index.outgoing("src/breadth/greeter.rb#Greeting.Greeter.greet").map((e) => e.toName)).toContain("format_name");
  });

  it("extracts php definitions and calls through the generic tier", () => {
    expect(symbolsOf("src/breadth/greeter.php")).toEqual([
      "module:src/breadth/greeter.php#App",
      "class:src/breadth/greeter.php#Greeter",
      "method:src/breadth/greeter.php#Greeter.greet",
      "method:src/breadth/greeter.php#Greeter.format",
      "function:src/breadth/greeter.php#run",
    ]);
    expect(index.outgoing("src/breadth/greeter.php#Greeter.greet").map((e) => e.toName)).toContain("format");
  });

  it("extracts kotlin definitions and calls through the generic tier", () => {
    expect(symbolsOf("src/breadth/Greeter.kt")).toEqual([
      "class:src/breadth/Greeter.kt#Greeter",
      "method:src/breadth/Greeter.kt#Greeter.greet",
      "method:src/breadth/Greeter.kt#Greeter.format",
      "function:src/breadth/Greeter.kt#run",
    ]);
    expect(index.outgoing("src/breadth/Greeter.kt#Greeter.greet").map((e) => e.toName)).toContain("format");
  });

  it("extracts swift definitions and calls through the generic tier", () => {
    expect(symbolsOf("src/breadth/Greeter.swift")).toEqual([
      "struct:src/breadth/Greeter.swift#Point",
      "class:src/breadth/Greeter.swift#Greeter",
      "method:src/breadth/Greeter.swift#Greeter.greet",
      "method:src/breadth/Greeter.swift#Greeter.format",
      "function:src/breadth/Greeter.swift#run",
    ]);
    expect(index.outgoing("src/breadth/Greeter.swift#Greeter.greet").map((e) => e.toName)).toContain("format");
  });

  it("extracts scala definitions and calls through the generic tier", () => {
    expect(symbolsOf("src/breadth/Greeter.scala")).toEqual([
      "class:src/breadth/Greeter.scala#Runner",
      "method:src/breadth/Greeter.scala#Runner.run",
      "class:src/breadth/Greeter.scala#Greeter",
      "method:src/breadth/Greeter.scala#Greeter.greet",
      "method:src/breadth/Greeter.scala#Greeter.format",
      "trait:src/breadth/Greeter.scala#Named",
      "method:src/breadth/Greeter.scala#Named.name",
    ]);
    expect(index.outgoing("src/breadth/Greeter.scala#Greeter.greet").map((e) => e.toName)).toContain("format");
  });

  it("extracts dart definitions through the generic tier", () => {
    expect(symbolsOf("src/breadth/greeter.dart")).toEqual([
      "class:src/breadth/greeter.dart#Greeter",
      "method:src/breadth/greeter.dart#Greeter.greet",
      "method:src/breadth/greeter.dart#Greeter.format",
      "function:src/breadth/greeter.dart#run",
    ]);
  });

  it("extracts elixir definitions and calls through the generic tier", () => {
    expect(symbolsOf("src/breadth/greeter.ex")).toEqual([
      "module:src/breadth/greeter.ex#Greeter",
      "function:src/breadth/greeter.ex#Greeter.greet",
      "function:src/breadth/greeter.ex#Greeter.greet_safe",
      "function:src/breadth/greeter.ex#Greeter.run",
      "function:src/breadth/greeter.ex#Greeter.format",
    ]);
    const greetCalls = index.outgoing("src/breadth/greeter.ex#Greeter.greet");
    expect(greetCalls).toHaveLength(1);
    expect(greetCalls[0]?.toName).toBe("format");
    const greetSafeCalls = index.outgoing("src/breadth/greeter.ex#Greeter.greet_safe");
    expect(greetSafeCalls).toHaveLength(1);
    expect(greetSafeCalls[0]?.toName).toBe("format");
    const runCalls = index.outgoing("src/breadth/greeter.ex#Greeter.run");
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.toName).toBe("greet");
    const allCalls = index.edges.filter((e) => e.fromFile === "src/breadth/greeter.ex" && e.kind === "calls");
    expect(allCalls.map((e) => e.toName)).not.toContain("def");
    expect(allCalls.map((e) => e.toName)).not.toContain("defp");
    expect(allCalls.map((e) => e.toName)).not.toContain("defmodule");
    expect(allCalls.map((e) => e.toName)).not.toContain("is_binary");
    expect(allCalls.map((e) => e.toName)).not.toContain("run");
    expect(allCalls.some((e) => e.toSymbol !== undefined && e.toSymbol === e.fromSymbol)).toBe(false);
  });

  it("extracts ocaml definitions and calls through the generic tier", () => {
    expect(symbolsOf("src/breadth/greeter.ml")).toEqual([
      "module:src/breadth/greeter.ml#Greeter",
      "function:src/breadth/greeter.ml#Greeter.format",
      "function:src/breadth/greeter.ml#Greeter.greet",
      "function:src/breadth/greeter.ml#run",
      "constant:src/breadth/greeter.ml#answer",
    ]);
    expect(index.outgoing("src/breadth/greeter.ml#Greeter.greet").map((e) => e.toName)).toContain("format");
  });

  it("extracts zig definitions and calls through the generic tier", () => {
    expect(symbolsOf("src/breadth/greeter.zig")).toEqual([
      "struct:src/breadth/greeter.zig#Greeter",
      "method:src/breadth/greeter.zig#Greeter.greet",
      "method:src/breadth/greeter.zig#Greeter.format",
      "function:src/breadth/greeter.zig#run",
    ]);
    expect(index.outgoing("src/breadth/greeter.zig#Greeter.greet").map((e) => e.toName)).toContain("format");
  });

  it("extracts bash definitions and calls through the generic tier", () => {
    expect(symbolsOf("src/breadth/greeter.sh")).toEqual([
      "function:src/breadth/greeter.sh#greet",
      "function:src/breadth/greeter.sh#format",
    ]);
    expect(index.outgoing("src/breadth/greeter.sh#greet").map((e) => e.toName)).toContain("format");
  });

  it("gives unindexed files a bare fallback card", () => {
    const card = index.files.get("docs/notes.txt");
    expect(card).toBeDefined();
    expect(card?.language).toBe("fallback");
    expect(card?.symbols).toHaveLength(0);
  });

  it("keeps spans one-based and inclusive", () => {
    const pad = index.symbols.get("src/util.ts#pad");
    expect(pad?.span.startLine).toBe(17);
    expect(pad?.span.endLine).toBe(20);
  });
});

describe("typescript variance annotations", () => {
  const frame = [
    "export class Frame<out Shape = unknown> {",
    "  constructor(readonly shape: Shape) {}",
    "  measure() { return this.shape.area(); }",
    "}",
    "export class Sink<in Shape = unknown> {",
    "  constructor(readonly shape: Shape) {}",
    "  drain() { return this.shape.area(); }",
    "}",
    "export interface Box<",
    "  out Shape extends object = object,",
    "> {",
    "  shape: Shape;",
    "}",
    "export function outline(frame: Frame<object>) { return frame.measure(); }",
    "",
  ].join("\n");
  const shape = "export class Shape {\n  area(): number { return 1; }\n}\n";

  it("keeps a type parameter the grammar cannot parse out of the field type hints", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-variance-"));
    try {
      fs.writeFileSync(path.join(dir, "frame.ts"), frame);
      fs.writeFileSync(path.join(dir, "shape.ts"), shape);
      const built = await buildIndex(dir);
      expect((built.diagnostics ?? []).map((d) => `${d.code}:${d.path}`)).toEqual(["syntax-errors:frame.ts"]);
      expect(symbolsIn(built, "frame.ts")).toEqual([
        "class:frame.ts#Frame",
        "method:frame.ts#Frame.constructor",
        "method:frame.ts#Frame.measure",
        "class:frame.ts#Sink",
        "method:frame.ts#Sink.constructor",
        "method:frame.ts#Sink.drain",
        "interface:frame.ts#Box",
        "function:frame.ts#outline",
      ]);
      expect(built.symbols.get("frame.ts#Frame")?.fieldTypes).toBeUndefined();
      expect(built.symbols.get("frame.ts#Sink")?.fieldTypes).toBeUndefined();
      expect(built.symbols.get("frame.ts#Box")?.fieldTypes).toBeUndefined();
      const areaCalls = built.edges.filter((e) => e.kind === "calls" && e.toName === "area");
      expect(areaCalls.map((e) => `${e.fromSymbol}->${e.toSymbol ?? "unresolved"}`)).toEqual([
        "frame.ts#Frame.measure->unresolved",
        "frame.ts#Sink.drain->unresolved",
      ]);
      const outline = built.edges.find((e) => e.fromSymbol === "frame.ts#outline" && e.toName === "measure");
      expect(outline?.toSymbol).toBe("frame.ts#Frame.measure");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("function value references", () => {
  const tsLib = [
    "export function helper(): number { return 1; }",
    "export function other(): number { return 2; }",
    "export class Widget { constructor(readonly cb: unknown) {} }",
    'export const NAME = "x";',
    "",
  ].join("\n");
  const tsMain = [
    'import { helper, other, Widget, NAME } from "./lib.js";',
    "function local(): number { return 3; }",
    "export function useAll(xs: number[], flag: boolean, cb = helper): unknown {",
    "  const alias = local;",
    "  let late; late = helper;",
    "  const arr = [other];",
    "  const obj = { run: helper, other };",
    "  xs.sort(local);",
    "  const pick = flag ? helper : other;",
    "  const fall = late ?? helper;",
    "  const fall2 = late || local;",
    "  let acc; acc ??= helper;",
    "  acc ||= other;",
    "  acc &&= local;",
    "  const both = flag && helper;",
    "  const text = `${helper}`;",
    "  const value = new Widget(helper);",
    "  console.log(NAME, alias, arr, obj, pick, fall, fall2, acc, both, text, value, cb);",
    "  return helper;",
    "}",
    "export function nonEmit(): void {",
    "  helper();",
    "  const t = typeof helper;",
    "  const w = { helper: 1 }.helper;",
    '  const s = "helper";',
    "  unbound(helper2);",
    "  void t; void w; void s;",
    "}",
    "",
  ].join("\n");
  const pyLib = [
    "def helper():",
    "    return 1",
    "",
    "def other():",
    "    return 2",
    "",
    "class Widget:",
    "    pass",
    "",
    "LIMIT = 3",
    "",
  ].join("\n");
  const pyMain = [
    "from lib import helper, other, Widget, LIMIT",
    "",
    "def local():",
    "    return 3",
    "",
    "def use_all(xs, flag, cb=helper):",
    "    alias = local",
    "    arr = [other]",
    "    pair = {\"run\": helper}",
    "    tup = (other, 1)",
    "    xs.sort(key=local)",
    "    list(map(helper, xs))",
    "    pick = helper if flag else other",
    "    fall = alias or helper",
    "    both = flag and helper",
    "    xs += other",
    "    text = f\"{helper}\"",
    "    a, b = other, helper",
    "    obj = isinstance(xs, Widget)",
    "    print(LIMIT, alias, arr, pair, tup, pick, fall, both, text, a, b, obj, cb)",
    "    return helper",
    "",
    "def non_emit(x):",
    "    helper()",
    "    y = x.helper",
    "    s = \"helper\"",
    "    unbound(helper2)",
    "    return y, s",
    "",
    "class Child(Widget):",
    "    pass",
    "",
  ].join("\n");

  const references = (built: OsnovaIndex, file: string): string[] =>
    built.edges.filter((e) => e.fromFile === file && e.kind === "references")
      .map((e) => `${e.line}:${e.fromSymbol}->${e.toName}=${e.toSymbol ?? "unresolved"}[${e.evidence?.source === "syntax" && e.evidence.resolution.status === "resolved" ? e.evidence.resolution.method : e.evidence?.source === "syntax" ? e.evidence.resolution.status : "?"}]`);

  it("emits a bound references edge for every typescript value position and none elsewhere", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-valueref-ts-"));
    try {
      fs.writeFileSync(path.join(dir, "lib.ts"), tsLib);
      fs.writeFileSync(path.join(dir, "main.ts"), tsMain);
      const built = await buildIndex(dir);
      expect(references(built, "main.ts")).toEqual([
        "3:main.ts#useAll->helper=lib.ts#helper[import-binding]",
        "4:main.ts#useAll->local=main.ts#local[lexical-definition]",
        "5:main.ts#useAll->helper=lib.ts#helper[import-binding]",
        "6:main.ts#useAll->other=lib.ts#other[import-binding]",
        "7:main.ts#useAll->helper=lib.ts#helper[import-binding]",
        "7:main.ts#useAll->other=lib.ts#other[import-binding]",
        "8:main.ts#useAll->local=main.ts#local[lexical-definition]",
        "9:main.ts#useAll->helper=lib.ts#helper[import-binding]",
        "9:main.ts#useAll->other=lib.ts#other[import-binding]",
        "10:main.ts#useAll->helper=lib.ts#helper[import-binding]",
        "11:main.ts#useAll->local=main.ts#local[lexical-definition]",
        "12:main.ts#useAll->helper=lib.ts#helper[import-binding]",
        "13:main.ts#useAll->other=lib.ts#other[import-binding]",
        "14:main.ts#useAll->local=main.ts#local[lexical-definition]",
        "15:main.ts#useAll->helper=lib.ts#helper[import-binding]",
        "16:main.ts#useAll->helper=lib.ts#helper[import-binding]",
        "17:main.ts#useAll->helper=lib.ts#helper[import-binding]",
        "18:main.ts#useAll->alias=main.ts#local[lexical-definition]",
        "19:main.ts#useAll->helper=lib.ts#helper[import-binding]",
      ]);
      const nonEmit = built.edges.filter((e) => e.fromSymbol === "main.ts#nonEmit");
      expect(nonEmit.map((e) => `${e.kind}:${e.toName}`).sort()).toEqual(["calls:helper", "calls:unbound"]);
      expect(built.edges.some((e) => e.toName === "helper2" || e.toName === "NAME")).toBe(false);
      expect(built.edges.some((e) => e.kind === "references" && e.binding === undefined)).toBe(false);
      const detailed = callersDetailed(built, "lib.ts#helper");
      expect(detailed.status).toBe("found");
      if (detailed.status !== "found") return;
      expect(detailed.reach?.d1.edges).toBe(11);
      const text = formatCallersDetailed(detailed);
      expect(text).toContain("d1 references main.ts#useAll:3,5,7,9,10,12,15,16,17,19 [import-binding]");
      expect(text).toContain("d1 calls main.ts#nonEmit:22 [import-binding]");
      expect(formatCallers(callers(built, "main.ts#local"))).toContain("d1 references function main.ts#useAll main.ts:4");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits a bound references edge for every python value position and none elsewhere", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-valueref-py-"));
    try {
      fs.writeFileSync(path.join(dir, "lib.py"), pyLib);
      fs.writeFileSync(path.join(dir, "main.py"), pyMain);
      const built = await buildIndex(dir);
      expect(references(built, "main.py").filter((line) => !line.startsWith("1:"))).toEqual([
        "6:main.py#use_all->helper=lib.py#helper[import-binding]",
        "7:main.py#use_all->local=main.py#local[lexical-definition]",
        "8:main.py#use_all->other=lib.py#other[import-binding]",
        "9:main.py#use_all->helper=lib.py#helper[import-binding]",
        "10:main.py#use_all->other=lib.py#other[import-binding]",
        "11:main.py#use_all->local=main.py#local[lexical-definition]",
        "12:main.py#use_all->helper=lib.py#helper[import-binding]",
        "13:main.py#use_all->helper=lib.py#helper[import-binding]",
        "13:main.py#use_all->other=lib.py#other[import-binding]",
        "14:main.py#use_all->alias=main.py#local[lexical-definition]",
        "14:main.py#use_all->helper=lib.py#helper[import-binding]",
        "15:main.py#use_all->helper=lib.py#helper[import-binding]",
        "16:main.py#use_all->other=lib.py#other[import-binding]",
        "17:main.py#use_all->helper=lib.py#helper[import-binding]",
        "18:main.py#use_all->helper=lib.py#helper[import-binding]",
        "18:main.py#use_all->other=lib.py#other[import-binding]",
        "19:main.py#use_all->Widget=lib.py#Widget[import-binding]",
        "20:main.py#use_all->alias=main.py#local[lexical-definition]",
        "21:main.py#use_all->helper=lib.py#helper[import-binding]",
      ]);
      const nonEmit = built.edges.filter((e) => e.fromSymbol === "main.py#non_emit");
      expect(nonEmit.map((e) => `${e.kind}:${e.toName}`).sort()).toEqual(["calls:helper", "calls:unbound"]);
      expect(built.edges.some((e) => e.toName === "helper2")).toBe(false);
      expect(built.edges.some((e) => e.kind === "references" && e.toName === "LIMIT" && e.line !== 1)).toBe(false);
      expect(built.edges.some((e) => e.kind === "references" && e.line === 30)).toBe(false);
      expect(built.symbols.get("main.py#Child")?.heritage).toEqual([{ kind: "import", source: "lib", importedName: "Widget" }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("constructor calls inside decorator arguments", () => {
  const py = [
    "class Top:",
    "    def __init__(self):",
    "        pass",
    "",
    "class Bare:",
    "    pass",
    "",
    "def register(*args):",
    "    return lambda f: f",
    "",
    "def outer():",
    "    class Nested:",
    "        def __init__(self):",
    "            pass",
    "",
    "    direct = Nested()",
    "",
    "    @register(Nested(), Top(), Bare(), Unbound())",
    "    def cmd():",
    "        pass",
    "",
    "    return cmd, direct",
    "",
  ].join("\n");
  const ts = [
    "class Top {",
    "  constructor() {}",
    "}",
    "class Bare {}",
    "function register(...args: unknown[]) { return (t: unknown) => t; }",
    "function outer() {",
    "  class Nested {",
    "    constructor() {}",
    "  }",
    "  const direct = new Nested();",
    "  @register(new Nested(), new Top(), new Bare(), new Unbound())",
    "  class Cmd {}",
    "  return [Cmd, direct];",
    "}",
    "",
  ].join("\n");

  function callsFrom(built: OsnovaIndex, fromSymbol: string): string[] {
    return built.edges
      .filter((e) => e.kind === "calls" && e.fromSymbol === fromSymbol)
      .map((e) => {
        const resolution = e.evidence?.source === "syntax" ? e.evidence.resolution : undefined;
        const outcome = resolution?.status === "unresolved" ? `unresolved:${resolution.reason}` : `unresolved:${resolution?.status ?? "unknown"}`;
        return `${e.line}:${e.toName}->${e.toSymbol ?? outcome}`;
      });
  }

  it("binds python constructor calls in decorator arguments to the class declaration", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-ctor-"));
    try {
      fs.writeFileSync(path.join(dir, "deco.py"), py);
      const built = await buildIndex(dir);
      expect(built.diagnostics ?? []).toEqual([]);
      expect(callsFrom(built, "deco.py#outer")).toEqual([
        "16:Nested->deco.py#outer.Nested",
        "18:Bare->deco.py#Bare",
        "18:Nested->deco.py#outer.Nested",
        "18:Top->deco.py#Top",
        "18:Unbound->unresolved:unbound-global",
        "18:register->deco.py#register",
      ]);
      expect(built.edges.filter((e) => e.kind === "references" && e.toName === "register").map((e) => e.line)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("binds typescript new expressions in decorator arguments to the class declaration", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-ctor-"));
    try {
      fs.writeFileSync(path.join(dir, "deco.ts"), ts);
      const built = await buildIndex(dir);
      expect(built.diagnostics ?? []).toEqual([]);
      expect(callsFrom(built, "deco.ts#outer")).toEqual(["10:Nested->deco.ts#outer.Nested"]);
      expect(callsFrom(built, "deco.ts#outer.Cmd")).toEqual([
        "11:Bare->deco.ts#Bare",
        "11:Nested->deco.ts#outer.Nested",
        "11:Top->deco.ts#Top",
        "11:Unbound->unresolved:unbound-global",
      ]);
      expect(built.edges.filter((e) => e.kind === "references" && e.toName === "register").map((e) => e.line)).toEqual([11]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function symbolsIn(built: OsnovaIndex, file: string): string[] {
  return (built.files.get(file)?.symbols ?? []).map((s) => `${s.kind}:${s.qualifiedName}`);
}

describe("inheritance edges", () => {
  const tsLib = [
    "export class Base {}",
    "export interface Reader { read(): string }",
    "export interface Closer { close(): void }",
    "export type Alias = { tag: string };",
    "",
  ].join("\n");

  const tsMain = [
    'import { Base, Closer, Reader } from "./lib.js";',
    "",
    "export class Leaf extends Base implements Reader, Closer {",
    "  read(): string { return \"\"; }",
    "  close(): void {}",
    "}",
    "",
    "export interface Both extends Reader, Closer {}",
    "",
    "class Local {}",
    "class Near extends Local {}",
    "class Ambient extends Error {}",
    "",
  ].join("\n");

  const pyBase = ["class Widget:", "    pass", ""].join("\n");

  const pyApp = [
    "from base import Widget",
    "",
    "class Child(Widget):",
    "    pass",
    "",
    "class Local:",
    "    pass",
    "",
    "class Near(Local):",
    "    pass",
    "",
    "class Deep(Widget, Local):",
    "    pass",
    "",
    "class Gen(Widget[int]):",
    "    pass",
    "",
    "class Outside(Missing):",
    "    pass",
    "",
  ].join("\n");

  const heritage = (built: OsnovaIndex, file: string): string[] =>
    built.edges.filter((e) => e.fromFile === file && e.kind === "extends")
      .map((e) => {
        const resolution = e.evidence?.source === "syntax" ? e.evidence.resolution : undefined;
        const basis = resolution?.status === "resolved" ? resolution.method : resolution?.status === "unresolved" ? `unresolved:${resolution.reason}` : resolution?.status ?? "?";
        return `${e.line}:${e.fromSymbol}->${e.toName}=${e.toSymbol ?? "unresolved"}[${basis}]`;
      });

  it("records typescript extends and implements clauses as extends edges", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-extends-ts-"));
    try {
      fs.writeFileSync(path.join(dir, "lib.ts"), tsLib);
      fs.writeFileSync(path.join(dir, "main.ts"), tsMain);
      const built = await buildIndex(dir);
      expect(built.diagnostics ?? []).toEqual([]);
      expect(heritage(built, "main.ts")).toEqual([
        "3:main.ts#Leaf->Base=lib.ts#Base[import-binding]",
        "3:main.ts#Leaf->Closer=lib.ts#Closer[import-binding]",
        "3:main.ts#Leaf->Reader=lib.ts#Reader[import-binding]",
        "8:main.ts#Both->Closer=lib.ts#Closer[import-binding]",
        "8:main.ts#Both->Reader=lib.ts#Reader[import-binding]",
        "11:main.ts#Near->Local=main.ts#Local[lexical-definition]",
        "12:main.ts#Ambient->Error=unresolved[unresolved:unbound-global]",
      ]);
      expect(built.incoming("lib.ts#Base").map((e) => e.kind)).toContain("extends");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records python base class lists as extends edges", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-extends-py-"));
    try {
      fs.writeFileSync(path.join(dir, "base.py"), pyBase);
      fs.writeFileSync(path.join(dir, "app.py"), pyApp);
      const built = await buildIndex(dir);
      expect(built.diagnostics ?? []).toEqual([]);
      expect(heritage(built, "app.py")).toEqual([
        "3:app.py#Child->Widget=base.py#Widget[import-binding]",
        "9:app.py#Near->Local=app.py#Local[lexical-definition]",
        "12:app.py#Deep->Local=app.py#Local[lexical-definition]",
        "12:app.py#Deep->Widget=base.py#Widget[import-binding]",
        "15:app.py#Gen->Widget=base.py#Widget[import-binding]",
        "18:app.py#Outside->Missing=unresolved[unresolved:unbound-global]",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never binds a heritage name to a non-type candidate", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-extends-kind-"));
    try {
      fs.writeFileSync(path.join(dir, "main.ts"), [
        "function Shadow() {}",
        "class Uses extends Shadow {}",
        "",
      ].join("\n"));
      const built = await buildIndex(dir);
      expect(heritage(built, "main.ts")).toEqual([
        "2:main.ts#Uses->Shadow=unresolved[unresolved:bound-symbol-missing]",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints an extends edge in warp output with its basis", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-extends-warp-"));
    try {
      fs.writeFileSync(path.join(dir, "lib.ts"), tsLib);
      fs.writeFileSync(path.join(dir, "main.ts"), tsMain);
      const built = await buildIndex(dir);
      const detailed = callersDetailed(built, "lib.ts#Base");
      expect(detailed.status).toBe("found");
      if (detailed.status !== "found") return;
      expect(formatCallersDetailed(detailed)).toContain("d1 extends main.ts#Leaf:3 [import-binding]");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("python decorator factory calls", () => {
  const regmod = [
    "def make(option):",
    "    return lambda f: f",
    "",
    "def plain(f):",
    "    return f",
    "",
  ].join("\n");

  const deco = [
    "import regmod",
    "from regmod import make, plain",
    "",
    "def local_factory(name):",
    "    return lambda f: f",
    "",
    "def outer(runtime):",
    "    @make('a')",
    "    @local_factory('b')",
    "    @regmod.make('c')",
    "    @plain",
    "    @runtime.build('d')",
    "    @missing('e')",
    "    def hello():",
    "        pass",
    "",
    "    @local_factory('cls')",
    "    class Thing:",
    "        pass",
    "",
    "    return hello, Thing",
    "",
  ].join("\n");

  function edgesOf(built: OsnovaIndex, kind: string, file: string): string[] {
    return built.edges
      .filter((e) => e.kind === kind && e.fromSymbol?.startsWith(file) === true)
      .map((e) => {
        const resolution = e.evidence?.source === "syntax" ? e.evidence.resolution : undefined;
        const outcome = e.toSymbol ?? `unresolved:${resolution?.status === "unresolved" ? resolution.reason : (resolution?.status ?? "unknown")}`;
        return `${e.line}:${e.fromSymbol}:${e.toName}->${outcome}`;
      })
      .sort();
  }

  it("emits a resolved calls edge for a python decorator factory and leaves a bare decorator a reference", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-pydeco-"));
    try {
      fs.writeFileSync(path.join(dir, "regmod.py"), regmod);
      fs.writeFileSync(path.join(dir, "deco.py"), deco);
      const built = await buildIndex(dir);
      expect(built.diagnostics ?? []).toEqual([]);
      expect(edgesOf(built, "calls", "deco.py")).toEqual([
        "10:deco.py#outer:make->regmod.py#make",
        "12:deco.py#outer:build->unresolved:receiver-unresolved",
        "13:deco.py#outer:missing->unresolved:unbound-global",
        "17:deco.py#outer:local_factory->deco.py#local_factory",
        "8:deco.py#outer:make->regmod.py#make",
        "9:deco.py#outer:local_factory->deco.py#local_factory",
      ]);
      expect(edgesOf(built, "references", "deco.py")).toEqual([
        "11:deco.py#outer:plain->regmod.py#plain",
        "21:deco.py#outer:Thing->deco.py#outer.Thing",
        "21:deco.py#outer:hello->deco.py#outer.hello",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

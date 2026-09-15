import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
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
      "function:src/breadth/greeter.ex#Greeter.format",
    ]);
    const greetCalls = index.outgoing("src/breadth/greeter.ex#Greeter.greet");
    expect(greetCalls).toHaveLength(1);
    expect(greetCalls[0]?.toName).toBe("format");
    const greetSafeCalls = index.outgoing("src/breadth/greeter.ex#Greeter.greet_safe");
    expect(greetSafeCalls).toHaveLength(1);
    expect(greetSafeCalls[0]?.toName).toBe("format");
    const allCalls = index.edges.filter((e) => e.fromFile === "src/breadth/greeter.ex" && e.kind === "calls");
    expect(allCalls.map((e) => e.toName)).not.toContain("def");
    expect(allCalls.map((e) => e.toName)).not.toContain("defp");
    expect(allCalls.map((e) => e.toName)).not.toContain("defmodule");
    expect(allCalls.map((e) => e.toName)).not.toContain("is_binary");
    expect(allCalls.some((e) => e.toSymbol !== undefined && e.toSymbol === e.fromSymbol)).toBe(false);
  });

  it("extracts ocaml definitions and calls through the generic tier", () => {
    expect(symbolsOf("src/breadth/greeter.ml")).toEqual([
      "module:src/breadth/greeter.ml#Greeter",
      "function:src/breadth/greeter.ml#Greeter.format",
      "function:src/breadth/greeter.ml#Greeter.greet",
      "function:src/breadth/greeter.ml#run",
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

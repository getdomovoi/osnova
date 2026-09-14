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

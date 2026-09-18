import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import type { OsnovaIndex } from "../src/types.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-repo");

let index: OsnovaIndex;
beforeAll(async () => {
  index = await buildIndex(FIXTURE, { cacheDir: ".tmp-coverage-cache" });
});

function symbolsOf(file: string): string[] {
  const card = index.files.get(file);
  expect(card, file).toBeDefined();
  return (card?.symbols ?? []).map((s) => `${s.kind}:${s.qualifiedName}`);
}

describe("python adapter extended paths", () => {
  it("extracts aliased imports and references", () => {
    const card = index.files.get("src/pyclient.py");
    expect(card).toBeDefined();
    const refs = index.edges
      .filter((e) => e.fromFile === "src/pyclient.py" && e.kind === "references")
      .map((e) => e.toName);
    expect(refs).toContain("helper");
  });

  it("resolves nested package __init__ imports", () => {
    const imports = index.edges.filter(
      (e) => e.fromFile === "src/pyrelative.py" && e.kind === "imports",
    );
    expect(imports.some((e) => e.toFile === "src/pyhelpers/__init__.py")).toBe(true);
  });

  it("records decorator references on decorated defs", () => {
    const deco = index.edges.find(
      (e) => e.fromFile === "src/server.py" && e.kind === "references" && e.toName === "registered",
    );
    expect(deco).toBeDefined();
  });
});

describe("rust adapter extended paths", () => {
  it("extracts enums, traits with default methods, and type aliases", () => {
    expect(symbolsOf("src/more.rs")).toEqual([
      "enum:src/more.rs#Mode",
      "trait:src/more.rs#Runner",
      "method:src/more.rs#Runner.name",
      "method:src/more.rs#Runner.run",
      "type:src/more.rs#Pair",
      "function:src/more.rs#scoped",
      "function:src/more.rs#generic_call",
      "function:src/more.rs#with_display",
    ]);
  });

  it("records scoped and field call targets", () => {
    const scopedCalls = index.outgoing("src/more.rs#scoped").map((e) => e.toName);
    expect(scopedCalls).toContain("insert");
    expect(scopedCalls).toContain("len");
  });

  it("resolves use imports without visibility noise", () => {
    const imports = index.edges.filter(
      (e) => e.fromFile === "src/more.rs" && e.kind === "imports",
    );
    expect(imports.some((e) => e.toName.includes("HashMap"))).toBe(true);
    expect(imports.some((e) => e.toName.includes("Display"))).toBe(true);
  });
});

describe("go adapter extended paths", () => {
  it("extracts interfaces and multi-import blocks", () => {
    expect(symbolsOf("src/extra.go")).toEqual([
      "struct:src/extra.go#Pair",
      "interface:src/extra.go#Stringer",
      "method:src/extra.go#Stringer.String",
      "function:src/extra.go#Reverse",
    ]);
    const imports = index.edges.filter(
      (e) => e.fromFile === "src/extra.go" && e.kind === "imports",
    );
    expect(imports.map((e) => e.toName).sort()).toEqual(["fmt", "strings"]);
  });
});

describe("c# adapter extended paths", () => {
  it("extracts enums and interfaces with usings", () => {
    expect(symbolsOf("src/Extra.cs")).toEqual([
      "enum:src/Extra.cs#Level",
      "interface:src/Extra.cs#IThing",
      "method:src/Extra.cs#IThing.Name",
    ]);
    const imports = index.edges.filter(
      (e) => e.fromFile === "src/Extra.cs" && e.kind === "imports",
    );
    expect(imports[0]?.toName).toContain("Collections.Generic");
  });
});

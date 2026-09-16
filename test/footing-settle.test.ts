import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import type { FileCard, OsnovaEdge, OsnovaSymbol } from "../src/types.js";
import { impact } from "../src/query/impact.js";
import { taskContext } from "../src/query/task-context.js";
import { formatImpact, formatTaskContext } from "../src/query/format.js";

function card(path: string, names: string[], text = `${names.map((name) => `function ${name}() { return 1; }`).join("\n")}\n`): FileCard {
  const symbols: OsnovaSymbol[] = names.map((name, i) => ({ name, qualifiedName: `${path}#${name}`, file: path,
    kind: "function", signature: `function ${name}()`, lineCount: 1,
    span: { startLine: i + 1, endLine: i + 1, startCol: 0, endCol: (text.split("\n")[i] ?? "").length } }));
  return { path, symbols, text, hash: createHash("sha256").update(text).digest("hex"),
    language: names.length ? "typescript" : "fallback", size: text.length, lineCount: text.split("\n").length };
}

function edge(from: string, to: string): OsnovaEdge {
  return { kind: "calls", fromFile: from.split("#")[0]!, fromSymbol: from, toName: to.split("#")[1]!,
    toSymbol: to, toFile: to.split("#")[0]!, line: 1,
    evidence: { source: "syntax", resolution: { status: "resolved", method: "import-binding" } } };
}

function index(files: FileCard[], edges: OsnovaEdge[] = []): OsnovaIndexImpl {
  return new OsnovaIndexImpl("/fixture", new Map(files.map((file) => [file.path, file])), edges);
}

describe("settle on a single index", () => {
  const current = index([card("a.ts", ["target"]), card("b.ts", ["middle"]), card("c.test.ts", ["check"])],
    [edge("b.ts#middle", "a.ts#target"), edge("c.test.ts#check", "b.ts#middle")]);
  const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-function target() { return 1; }\n+function target() { return 2; }\n";

  it("walks dependents once when base and current are the same index", () => {
    const result = impact(current, current, { diff });
    expect(result.changes.map((change) => [change.kind, change.basis])).toEqual([["changed", "diff-range"]]);
    expect(result.dependents.map((hit) => [hit.snapshot, hit.symbol?.name, hit.depth])).toEqual([
      ["current", "middle", 1], ["current", "check", 2],
    ]);
    expect(result.uncertainty.unresolvedEdges).toBe(0);
    expect(result.uncertainty.notes).toContain("base-snapshot-is-current-index");
  });

  it("uses current-side coordinates only when base and current are the same index", () => {
    const one = index([card("a.ts", ["keep"])]);
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,1 @@\n-function gone() { return 1; }\n function keep() { return 1; }\n";
    const result = impact(one, one, { diff });
    expect(result.changes).toEqual([]);
    const touching = "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-function keep() { return 0; }\n+function keep() { return 1; }\n";
    expect(impact(one, one, { diff: touching }).changes.map((change) => change.after?.symbol.name)).toEqual(["keep"]);
  });

  it("formats settle output with counts before detail", () => {
    const text = formatImpact(impact(current, current, { diff, maxDepth: 1 }));
    expect(text.split("\n")[0]).toBe("osnova settle: 1 symbol changes; 1 dependents; 1 frontier items omitted");
    expect(text).toContain("changed: a.ts#target -> a.ts#target");
    expect(text).toContain("current d1 b.ts#middle");
    expect(text).toContain("uncertainty: 0 unresolved edges;");
  });
});

describe("footing formatting", () => {
  const current = index([card("a.ts", ["target"]), card("b.ts", ["middle"]), card("c.test.ts", ["check"])],
    [edge("b.ts#middle", "a.ts#target"), edge("c.test.ts#check", "b.ts#middle")]);

  it("lists definitions with excerpts, relationships, tests and omissions", () => {
    const result = taskContext(current, { task: "change", question: "", symbols: ["a.ts#target"] });
    const text = formatTaskContext(result);
    const lines = text.split("\n");
    expect(lines[0]).toBe("osnova footing: change, scope ., 3 definitions, 2 relationships, 1 candidate tests");
    expect(text).toContain("- a.ts#target function lines 1-1\n  function target() { return 1; }");
    expect(text).toContain("- b.ts#middle -> a.ts#target calls line 1");
    expect(text).toContain("candidate tests:\n- c.test.ts via c.test.ts#check");
    expect(text).toContain("omitted: 0 definitions, 0 relationships, 0 candidate tests, 0 retrieval hits, 0 uncertain edges, 0 out-of-scope edges, 0 depth frontier, 0 unknown symbols");
    expect(text).toContain("limitations: indexed-structural-evidence-only");
  });

  it("stores clipped excerpts when excerptLines is set so the budget matches printed text", () => {
    const body = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const text = `function big() {\n${body}\n}\nfunction small() { return big(); }\n`;
    const big: OsnovaSymbol = { name: "big", qualifiedName: "big.ts#big", kind: "function", file: "big.ts",
      span: { startLine: 1, startCol: 0, endLine: 202, endCol: 1 }, signature: "function big()", lineCount: 202 };
    const small: OsnovaSymbol = { name: "small", qualifiedName: "big.ts#small", kind: "function", file: "big.ts",
      span: { startLine: 203, startCol: 0, endLine: 203, endCol: 34 }, signature: "function small()", lineCount: 1 };
    const file: FileCard = { ...card("big.ts", [], text), language: "typescript", symbols: [big, small] };
    const one = index([file], [edge("big.ts#small", "big.ts#big")]);
    const full = taskContext(one, { task: "change", question: "", symbols: ["big.ts#big"], maxCodeUnits: 3_072 });
    expect(full.definitions.map((definition) => definition.symbol.name)).not.toContain("big");
    expect(full.omitted.definitions).toBe(1);
    const clipped = taskContext(one, { task: "change", question: "", symbols: ["big.ts#big"], maxCodeUnits: 3_072, excerptLines: 8 });
    expect(clipped.definitions[0]?.excerpt).toBe(`${text.split("\n").slice(0, 8).join("\n")}\n[+194 more lines]`);
    expect(clipped.definitions.map((definition) => definition.symbol.name)).toEqual(["big", "small"]);
    expect(clipped.relationships).toHaveLength(1);
    expect(clipped.omitted).toMatchObject({ definitions: 0, relationships: 0 });
    expect(formatTaskContext(clipped)).toContain("  const v6 = 6;\n  [+194 more lines]\n- big.ts#small");
  });

  it("keeps relationships ahead of related definitions when the budget is tight", () => {
    const names = Array.from({ length: 12 }, (_, i) => `fn${i}`);
    const one = index([card("many.ts", names)], names.slice(1).map((name) => edge(`many.ts#${name}`, "many.ts#fn0")));
    const tight = taskContext(one, { task: "change", question: "", symbols: ["many.ts#fn0"], maxCodeUnits: 1_500,
      measure: (partial) => formatTaskContext(partial).length });
    expect(tight.definitions[0]?.symbol.name).toBe("fn0");
    expect(tight.relationships.length).toBeGreaterThan(0);
    expect(tight.definitions.length).toBeLessThan(1 + tight.relationships.length);
    expect(tight.omitted.relationships + tight.relationships.length).toBe(11);
    expect(tight.omitted.definitions + tight.definitions.length).toBe(12);
  });

  it("reports the short hunk line when a diff is summarized", () => {
    const one = index([card("a.ts", ["keep"])]);
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1,7 +1,7 @@\n-function keep() { return 0; }\n+function keep() { return 1; }\n@@ -20,7 +20,7 @@\n";
    expect(() => impact(one, one, { diff })).toThrow(/hunk line 6: the hunk header promised 6 more old and 6 more new lines/);
  });

  it("fits by the caller's measure instead of JSON size", () => {
    const names = Array.from({ length: 12 }, (_, i) => `fn${i}`);
    const one = index([card("many.ts", names)], names.slice(1).map((name) => edge(`many.ts#${name}`, "many.ts#fn0")));
    const byJson = taskContext(one, { task: "change", question: "", symbols: ["many.ts#fn0"], maxCodeUnits: 2_600 });
    const byText = taskContext(one, { task: "change", question: "", symbols: ["many.ts#fn0"], maxCodeUnits: 2_600,
      measure: (partial) => formatTaskContext(partial).length });
    expect(byJson.relationships.length).toBeLessThan(byText.relationships.length);
    expect(byText.relationships).toHaveLength(11);
    expect(byText.omitted.relationships).toBe(0);
    expect(formatTaskContext(byText).length).toBeLessThanOrEqual(2_600);
  });

  it("clips long excerpts to eight lines with a count", () => {
    const body = Array.from({ length: 12 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const text = `function big() {\n${body}\n}\n`;
    const symbol: OsnovaSymbol = { name: "big", qualifiedName: "big.ts#big", kind: "function", file: "big.ts",
      span: { startLine: 1, startCol: 0, endLine: 14, endCol: 1 }, signature: "function big()", lineCount: 14 };
    const file: FileCard = { ...card("big.ts", [], text), language: "typescript", symbols: [symbol] };
    const out = formatTaskContext(taskContext(index([file]), { task: "understand", question: "", symbols: ["big.ts#big"] }));
    expect(out).toContain("  const v6 = 6;\n  [+6 more lines]");
    expect(out).not.toContain("const v7");
  });
});

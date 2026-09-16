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

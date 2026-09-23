import { describe, expect, it } from "vitest";
import { callers, callersDetailed } from "../src/index.js";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import { formatCallersDetailed } from "../src/query/format.js";
import type { FileCard, OsnovaEdge, OsnovaSymbol } from "../src/types.js";

const symbols: OsnovaSymbol[] = [
  ["a.ts", "work"], ["b.ts", "work"], ["caller.ts", "entry"], ["top.ts", "top"], ["unused.ts", "unused"],
].map(([file = "", name = ""]) => ({
  file, name, qualifiedName: `${file}#${name}`, kind: "function", signature: `function ${name}()`,
  span: { startLine: 1, endLine: 5, startCol: 0, endCol: 1 }, lineCount: 5,
}));
const files = new Map<string, FileCard>(symbols.map((symbol) => [symbol.file, {
  path: symbol.file, language: "typescript", hash: "fixture", size: 0, lineCount: 5,
  text: "", symbols: [symbol],
}]));
const edges: OsnovaEdge[] = [
  { kind: "calls", fromFile: "caller.ts", fromSymbol: "caller.ts#entry", toName: "work", toSymbol: "a.ts#work", toFile: "a.ts", line: 2 },
  { kind: "calls", fromFile: "caller.ts", fromSymbol: "caller.ts#entry", toName: "externalRequest", line: 3 },
  { kind: "calls", fromFile: "top.ts", fromSymbol: "top.ts#top", toName: "entry", toSymbol: "caller.ts#entry", toFile: "caller.ts", line: 2 },
  { kind: "calls", fromFile: "b.ts", fromSymbol: "b.ts#work", toName: "work", line: 2 },
];
const index = new OsnovaIndexImpl("/fixture", files, edges);

describe("caller evidence", () => {
  it("returns candidates instead of silently selecting a popular same-name target", () => {
    const result = callersDetailed(index, "work");
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") throw new Error("expected ambiguity");
    expect(result.candidates.map((symbol) => symbol.qualifiedName)).toEqual(["a.ts#work", "b.ts#work"]);
    const text = formatCallersDetailed(result);
    expect(text).toContain("ambiguous symbol");
    expect(text).toContain("a.ts#work");
    expect(text).toContain("b.ts#work");
  });

  it("keeps the legacy deterministic selection contract", () => {
    expect(callers(index, "work").target.qualifiedName).toBe("a.ts#work");
  });

  it("accepts qualified names and separates unresolved name matches", () => {
    const result = callersDetailed(index, "a.ts#work");
    expect(result.status).toBe("found");
    if (result.status !== "found") throw new Error("expected target");
    expect(result.hits.map((hit) => hit.qualifiedName)).toEqual(["caller.ts#entry"]);
    expect(result.unresolved.map((hit) => hit.edge.fromSymbol)).toEqual(["b.ts#work"]);
    expect(formatCallersDetailed(result)).toContain("not confirmed relationships");
  });

  it("keeps raw target names and call sites for unresolved transitive callees", () => {
    const result = callersDetailed(index, "top", { direction: "out", depth: 2 });
    if (result.status !== "found") throw new Error("expected target");
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]).toMatchObject({
      depth: 2, edge: { toName: "externalRequest", fromFile: "caller.ts", line: 3 },
    });
    expect(result.hits.every((hit) => hit.resolved)).toBe(true);
    const text = formatCallersDetailed(result);
    expect(text).toContain("externalRequest");
    expect(text).toContain("caller.ts:3");
  });

  it("qualifies absence and heuristic graph results", () => {
    const text = formatCallersDetailed(callersDetailed(index, "unused"));
    expect(text).toContain("no indexed relationships found");
    expect(text).toContain("does not prove absence of callers");
    expect(text).toContain("heuristic");
  });

  it.each([0, -1, 1.5, NaN, -Infinity])("rejects invalid depth %s", (depth) => {
    expect(() => callersDetailed(index, "work", { depth })).toThrow(RangeError);
  });

  it.each([0, -1, 1.5, NaN, -Infinity])("rejects invalid depth %s from callers instead of answering", (depth) => {
    expect(() => callers(index, "a.ts#work", { depth })).toThrow(RangeError);
  });

  it("walks the whole transitive graph when depth is Infinity", () => {
    const result = callers(index, "a.ts#work", { depth: Infinity });
    expect(result.hits.map((hit) => [hit.qualifiedName, hit.depth])).toEqual([
      ["caller.ts#entry", 1], ["top.ts#top", 2],
    ]);
  });

  it("walks the whole transitive graph from callersDetailed when depth is Infinity", () => {
    const result = callersDetailed(index, "a.ts#work", { depth: Infinity });
    if (result.status !== "found") throw new Error("expected target");
    expect(result.hits.map((hit) => [hit.qualifiedName, hit.depth])).toEqual([
      ["caller.ts#entry", 1], ["top.ts#top", 2],
    ]);
  });

  it("rejects an unknown direction from both entry points instead of walking callees", () => {
    expect(() => callers(index, "caller.ts#entry", { direction: "sideways" as never })).toThrow(RangeError);
    expect(() => callersDetailed(index, "caller.ts#entry", { direction: "sideways" as never })).toThrow(RangeError);
  });

  it("retains an error for missing symbols", () => {
    expect(() => callersDetailed(index, "missing")).toThrow(/no indexed symbol/);
  });
});

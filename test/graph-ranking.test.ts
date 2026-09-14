import { expect, it } from "vitest";
import { ask } from "../src/query/ask.js";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import type { AskOptions, FileCard, OsnovaEdge, OsnovaSymbol } from "../src/types.js";

function symbol(file: string, name: string, line = 1): OsnovaSymbol {
  return { name, qualifiedName: `${file}#${name}`, file, kind: "function", signature: `export function ${name}()`,
    span: { startLine: line, endLine: line, startCol: 0, endCol: 1 }, lineCount: 1 };
}
function graph(edges: OsnovaEdge[]): OsnovaIndexImpl {
  const files = new Map<string, FileCard>();
  for (const [file, names] of [["a.ts", ["dispatch"]], ["z.ts", ["dispatch"]], ["calls.ts", ["one", "two", "three"]]] as const) {
    files.set(file, { path: file, language: "typescript", hash: "fixture", size: 0, lineCount: names.length,
      text: names.map((name) => `export function ${name}() { return 1; }`).join("\n"),
      symbols: names.map((name, i) => symbol(file, name, i + 1)) });
  }
  return new OsnovaIndexImpl("/fixture", files, edges);
}
function edge(from: string, target: string, line = 1): OsnovaEdge {
  return { kind: "calls", fromFile: "calls.ts", fromSymbol: `calls.ts#${from}`, toName: "dispatch", line,
    toFile: target, toSymbol: `${target}#dispatch`, evidence: { source: "syntax", resolution: { status: "resolved", method: "import-binding" } } };
}
const options = (graphRank: boolean): AskOptions => ({ limit: 5, graphRank } as AskOptions);

it("can rerank an exact-name tie using distinct reliable callers", () => {
  const index = graph([edge("one", "z.ts"), edge("two", "z.ts")]);
  expect(ask(index, "dispatch", options(false)).hits[0]?.file).toBe("a.ts");
  expect(ask(index, "dispatch", options(true)).hits[0]?.file).toBe("z.ts");
});

it("does not use unknown or receiver-hint evidence for centrality", () => {
  const uncertain = edge("one", "z.ts");
  const index = graph([{ ...uncertain, evidence: { source: "unknown" } }, { ...edge("two", "z.ts"), evidence: {
    source: "syntax", resolution: { status: "resolved", method: "receiver-hint", receiver: { classSymbol: "z.ts#A", mode: "instance", basis: "lexical" } },
  } }]);
  expect(ask(index, "dispatch", options(true)).hits[0]?.file).toBe("a.ts");
});

it("counts a caller once regardless of repeated call sites", () => {
  const index = graph([edge("one", "a.ts"), edge("two", "a.ts"), ...Array.from({ length: 100 }, (_, i) => edge("three", "z.ts", i + 1))]);
  expect(ask(index, "dispatch", options(true)).hits[0]?.file).toBe("a.ts");
});

it("does not bring graph neighbors outside the requested path into results", () => {
  const index = graph([edge("one", "z.ts"), edge("two", "z.ts")]);
  const result = ask(index, "dispatch", { ...options(true), in: "a.ts" });
  expect(result.hits.every((hit) => hit.file === "a.ts")).toBe(true);
});

it("keeps the existing lexical order when no eligible graph links exist", () => {
  const index = graph([]);
  expect(ask(index, "dispatch", options(true)).hits.map((hit) => hit.symbol?.qualifiedName)).toEqual(
    ask(index, "dispatch", options(false)).hits.map((hit) => hit.symbol?.qualifiedName));
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { indexGeneration } from "../src/api.js";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import { indexReceipt } from "../src/query/impact.js";
import type { FileCard, OsnovaEdge, OsnovaSymbol } from "../src/types.js";

function card(path: string, names: string[]): FileCard {
  const text = names.map((name) => `function ${name}() { return 1; }`).join("\n");
  const symbols: OsnovaSymbol[] = names.map((name, i) => ({ name, qualifiedName: `${path}#${name}`, file: path,
    kind: "function", signature: `function ${name}()`, lineCount: 1,
    span: { startLine: i + 1, endLine: i + 1, startCol: 0, endCol: (text.split("\n")[i] ?? "").length } }));
  return { path, symbols, text, hash: createHash("sha256").update(text).digest("hex"),
    language: "typescript", size: text.length, lineCount: text.split("\n").length };
}

function edge(from: string, to: string): OsnovaEdge {
  return { kind: "calls", fromFile: from.split("#")[0]!, fromSymbol: from, toName: to.split("#")[1]!,
    toSymbol: to, toFile: to.split("#")[0]!, line: 1,
    evidence: { source: "syntax", resolution: { status: "resolved", method: "import-binding" } } };
}

function index(files: FileCard[], edges: OsnovaEdge[] = []): OsnovaIndexImpl {
  return new OsnovaIndexImpl("/fixture", new Map(files.map((file) => [file.path, file])), edges);
}

describe("index receipt generation", () => {
  it("reuses the artifact generation the index already carries", () => {
    const repo = index([card("a.ts", ["work"]), card("b.ts", ["run"])], [edge("b.ts#run", "a.ts#work")]);
    expect(indexReceipt(repo).generation).toBe(indexGeneration(repo));
  });

  it("stays identical for an index whose files arrive in a different order", () => {
    const a = card("a.ts", ["work"]);
    const b = card("b.ts", ["run"]);
    expect(indexReceipt(index([a, b])).generation).toBe(indexReceipt(index([b, a])).generation);
  });

  it("changes when an edge is added to the same files", () => {
    const a = card("a.ts", ["work"]);
    const b = card("b.ts", ["run"]);
    expect(indexReceipt(index([a, b])).generation)
      .not.toBe(indexReceipt(index([a, b], [edge("b.ts#run", "a.ts#work")])).generation);
  });
});

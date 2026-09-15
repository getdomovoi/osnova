import { describe, expect, it } from "vitest";
import { resolveEdges } from "../src/index/resolve.js";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import type { RawEdgeItem } from "../src/index/indexImpl.js";
import { deserializeArtifact, serializeArtifact, serializeSections } from "../src/index/serialize.js";
import { sha256Hex } from "../src/index/scan.js";
import { callers, callersDetailed } from "../src/query/callers.js";
import { formatCallersDetailed } from "../src/query/format.js";
import type { CardLanguage, FileCard } from "../src/types.js";
import { createHash } from "node:crypto";

function card(file: string, names: string[], language: CardLanguage = "typescript"): FileCard {
  const text = Array(20).fill("x").join("\n");
  return {
    path: file, language, hash: createHash("sha256").update(text).digest("hex"), size: Buffer.byteLength(text), lineCount: 20, text, symbols: names.map((name) => ({
      name: name.split(".").pop() ?? name, qualifiedName: `${file}#${name}`, file, kind: "function",
      signature: `function ${name}()`, lineCount: 1,
      span: { startLine: 10, endLine: 10, startCol: 0, endCol: 1 },
    })),
  };
}

function index(cards: FileCard[], from: string, edges: RawEdgeItem[]): OsnovaIndexImpl {
  const files = new Map(cards.map((file) => [file.path, file]));
  return new OsnovaIndexImpl("/fixture", files, resolveEdges({ root: "/fixture", files, rawEdges: new Map([[from, edges]]) }));
}

const call: RawEdgeItem = { kind: "calls", toName: "work", line: 3, enclosing: "entry" };
const imported: RawEdgeItem = { kind: "imports", toName: "./a.js", line: 1, enclosing: "" };

describe("edge provenance", () => {
  it("records syntax and the exact resolution tier", () => {
    const same = index([card("a.ts", ["work", "entry"])], "a.ts", [call]);
    expect(same.edges[0]?.evidence).toEqual({ source: "syntax", resolution: { status: "resolved", method: "same-file-name" } });
    const importedIndex = index([card("a.ts", ["work"]), card("entry.ts", ["entry"])], "entry.ts", [imported, call]);
    expect(importedIndex.edges[0]?.evidence).toEqual({ source: "syntax", resolution: { status: "resolved", method: "import-path" } });
    expect(importedIndex.edges[1]?.evidence).toEqual({ source: "syntax", resolution: { status: "resolved", method: "imported-file-name" } });
    const unique = index([card("a.ts", ["work"]), card("entry.ts", ["entry"])], "entry.ts", [call]);
    expect(unique.edges[0]?.evidence).toEqual({ source: "syntax", resolution: { status: "resolved", method: "unique-name" } });
  });

  it("does not arbitrarily choose between same-file methods", () => {
    const ambiguous = index([card("a.ts", ["A.work", "B.work", "entry"])], "a.ts", [call]);
    expect(ambiguous.edges[0]?.toSymbol).toBeUndefined();
    expect(ambiguous.edges[0]?.evidence).toEqual({ source: "syntax", resolution: {
      status: "ambiguous", candidates: ["a.ts#A.work", "a.ts#B.work"],
    } });
  });

  it("preserves ambiguity across multiple imported files", () => {
    const result = index([card("a.ts", ["work"]), card("b.ts", ["work"]), card("entry.ts", ["entry"])], "entry.ts", [
      imported, { ...imported, toName: "./b.js", line: 2 }, call,
    ]);
    expect(result.edges[2]?.toSymbol).toBeUndefined();
    expect(result.edges[2]?.evidence).toEqual({ source: "syntax", resolution: {
      status: "ambiguous", candidates: ["a.ts#work", "b.ts#work"],
    } });
  });

  it("does not connect a unique name in an unrelated language", () => {
    const result = index([card("a.py", ["work"], "python"), card("entry.ts", ["entry"])], "entry.ts", [call]);
    expect(result.edges[0]?.toSymbol).toBeUndefined();
    expect(result.edges[0]?.evidence).toEqual({ source: "syntax", resolution: {
      status: "unresolved", reason: "no-matching-symbol",
    } });
  });

  it("allows TypeScript, TSX and JavaScript to share the same language family", () => {
    const result = index([card("a.tsx", ["work"], "tsx"), card("entry.js", ["entry"], "javascript")], "entry.js", [call]);
    expect(result.edges[0]?.toSymbol).toBe("a.tsx#work");
  });

  it("keeps unresolved imports explicit", () => {
    const result = index([card("entry.ts", ["entry"])], "entry.ts", [imported]);
    expect(result.edges[0]?.evidence).toEqual({ source: "syntax", resolution: {
      status: "unresolved", reason: "import-target-unresolved",
    } });
  });

  it("persists evidence through artifact round trips", () => {
    const original = index([card("a.ts", ["A.work", "B.work", "entry"])], "a.ts", [call]);
    const sections = serializeSections(original);
    const loaded = deserializeArtifact(sections.core.toString(), undefined, sections.text.bytes, sections.edges.bytes);
    expect(loaded.edges[0]?.evidence?.source).toBe("syntax");
    expect(loaded.edges).toEqual(original.edges);
    expect(serializeArtifact(loaded)).toEqual(sections.core);
  });

  it("keeps ambiguous evidence deterministic regardless of input order", () => {
    const cards = [card("entry.ts", ["entry"]), card("a.ts", ["work"]), card("b.ts", ["work"])];
    expect(serializeArtifact(index(cards, "entry.ts", [call]))).toEqual(
      serializeArtifact(index([...cards].reverse(), "entry.ts", [call])),
    );
  });

  it("rejects corrupted provenance instead of claiming it is verified", () => {
    const graph = index([card("entry.ts", ["entry"])], "entry.ts", [call]);
    const sections = serializeSections(graph);
    const lines = sections.edges.bytes.toString("utf8").slice(0, -1).split("\n");
    const header = JSON.parse(lines[0]!) as { evidence: unknown[] };
    header.evidence.push({ source: "syntax", resolution: { status: "resolved", method: "invented" } });
    lines[0] = JSON.stringify(header);
    const edgeBytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    const data = JSON.parse(sections.core.toString()) as { edgesHash: string; edgesBytes: number };
    data.edgesHash = sha256Hex(edgeBytes);
    data.edgesBytes = edgeBytes.length;
    expect(() => deserializeArtifact(JSON.stringify(data), undefined, sections.text.bytes, edgeBytes)).toThrow(/corrupt edge evidence/);
  });

  it("exposes source call sites separately from callee definition locations", () => {
    const graph = index([card("a.ts", ["work"]), card("entry.ts", ["entry"])], "entry.ts", [imported, call]);
    const result = callersDetailed(graph, "entry", { direction: "out" });
    if (result.status !== "found") throw new Error("expected target");
    const hit = result.hits[0];
    expect(hit?.file).toBe("a.ts");
    expect(hit?.line).toBe(10);
    expect(hit?.edge.fromFile).toBe("entry.ts");
    expect(hit?.edge.line).toBe(3);
    const text = formatCallersDetailed(result);
    expect(text).toContain("imported-file-name");
    expect(text).toContain("entry.ts:3");
    expect(text).toContain("a.ts:10");
    expect(callers(graph, "entry", { direction: "out" }).hits[0]).not.toHaveProperty("edge");
  });
});

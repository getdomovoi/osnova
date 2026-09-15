import { describe, expect, it } from "vitest";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { serializeEdges, deserializeEdges, edgeKinds } from "../src/index/edgeStore.js";
import { sha256Hex } from "../src/index/scan.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-repo");

describe("edge store", () => {
  it("round-trips every edge through integer tuples", async () => {
    const index = await buildIndex(FIXTURE);
    const paths = [...index.files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const layout = serializeEdges(index.edges, paths);
    expect(layout.count).toBe(index.edges.length);
    expect(layout.hash).toBe(sha256Hex(layout.bytes));
    const back = deserializeEdges(layout.bytes, paths, index.files);
    expect(back).toEqual(index.edges);
    const again = serializeEdges(back, paths);
    expect(again.bytes.equals(layout.bytes)).toBe(true);
  });

  it("writes one header line and one line per edge, grouped by source file", async () => {
    const index = await buildIndex(FIXTURE);
    const paths = [...index.files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const lines = serializeEdges(index.edges, paths).bytes.toString("utf8").split("\n");
    expect(lines.at(-1)).toBe("");
    const header = JSON.parse(lines[0]!) as { formatVersion: number; count: number; evidence: unknown[]; bindings: unknown[] };
    expect(header.formatVersion).toBe(9);
    expect(header.count).toBe(index.edges.length);
    expect(lines.length - 2).toBe(index.edges.length);
    const fileIndexes = lines.slice(1, -1).map((line) => (JSON.parse(line) as number[])[1]!);
    expect([...fileIndexes]).toEqual([...fileIndexes].sort((a, b) => a - b));
    expect(edgeKinds).toEqual(["calls", "references", "imports"]);
  });

  it("rejects tuples that point outside the tables", async () => {
    const index = await buildIndex(FIXTURE);
    const paths = [...index.files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const lines = serializeEdges(index.edges, paths).bytes.toString("utf8").split("\n");
    const bad = JSON.parse(lines[1]!) as number[];
    bad[1] = paths.length + 5;
    lines[1] = JSON.stringify(bad);
    expect(() => deserializeEdges(Buffer.from(lines.join("\n")), paths, index.files)).toThrow(/corrupt edge/);
  });
});

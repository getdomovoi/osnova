import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { callersDetailed } from "../src/query/callers.js";
import { plumb, parseClaims } from "../src/query/plumb.js";
import { formatPlumb } from "../src/query/format.js";
import type { OsnovaIndex, OsnovaEdge } from "../src/types.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-repo");
let index: OsnovaIndex;
let resolved: OsnovaEdge[];
let name = "";
beforeAll(async () => {
  index = await buildIndex(FIXTURE);
  const counts = new Map<string, number>();
  for (const edge of index.edges) if (edge.kind === "calls" && edge.toSymbol !== undefined && edge.evidence?.source === "syntax" && edge.evidence.resolution.status === "resolved") counts.set(edge.toSymbol, (counts.get(edge.toSymbol) ?? 0) + 1);
  name = [...counts].filter(([, n]) => n >= 2).map(([symbol]) => symbol).sort()[0] ?? "";
  if (name === "") throw new Error("fixture needs a symbol with two resolved callers");
  const detailed = callersDetailed(index, name, { direction: "in", depth: 1 });
  if (detailed.status !== "found") throw new Error("fixture changed");
  resolved = detailed.hits.map((hit) => hit.edge);
});

describe("plumb", () => {
  it("confirms claimed sites that match resolved edges and lists the rest as missing", () => {
    const [first, ...others] = resolved;
    const result = plumb(index, name, [{ file: first!.fromFile, line: first!.line }]);
    expect(result.status).toBe("found");
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({ verdict: "confirmed", edge: { fromFile: first!.fromFile, line: first!.line } });
    expect(result.missing.map((edge) => `${edge.fromFile}:${edge.line}`)).toEqual(others.map((edge) => `${edge.fromFile}:${edge.line}`).sort());
    expect(result.counts).toEqual({ confirmed: 1, nameOnly: 0, noCall: 0, notIndexed: 0, missing: others.length });
    expect(result.limitations).toEqual(["confirmed-means-indexed-resolved-edge-not-runtime-proof", "name-only-is-a-heuristic-match", "missing-covers-indexed-resolved-edges-only"]);
  });

  it("marks lines without a call, unindexed files and duplicates", () => {
    const [first] = resolved;
    const claims = parseClaims([`${first!.fromFile}:${first!.line}`, `${first!.fromFile}:${first!.line}`, "src/util.ts:1", "nowhere/none.ts:3"]);
    const result = plumb(index, name, claims);
    expect(result.claims.map((claim) => claim.verdict)).toEqual(["confirmed", "no-call", "not-indexed"]);
    expect(result.counts).toMatchObject({ confirmed: 1, noCall: 1, notIndexed: 1 });
    const text = formatPlumb(result);
    expect(text.split("\n")[0]).toBe(`osnova plumb: ${name}, 1 confirmed, 0 name-only, 1 no-call, 1 not-indexed, ${result.counts.missing} missing`);
    expect(text).toContain(`confirmed ${first!.fromFile}:${first!.line} -> ${first!.fromSymbol}`);
    expect(text).toContain("no-call src/util.ts:1");
    expect(text).toContain("not-indexed nowhere/none.ts:3");
    expect(text).toContain("limitations: confirmed-means-indexed-resolved-edge-not-runtime-proof");
  });

  it("reports name-only for a heuristic match at a claimed line", () => {
    const local = name.slice(name.indexOf("#") + 1).split(".").pop()!;
    const heuristic = index.edges.find((edge) => edge.kind === "calls" && edge.toName === local && edge.evidence?.source === "syntax" && edge.evidence.resolution.status !== "resolved");
    if (heuristic === undefined) return;
    const result = plumb(index, name, [{ file: heuristic.fromFile, line: heuristic.line }]);
    expect(result.claims[0]?.verdict).toBe("name-only");
  });

  it("handles unknown symbols and bad claims", () => {
    expect(() => plumb(index, "doesNotExist", [])).toThrow(/no indexed symbol/);
    expect(() => parseClaims(["src/util.ts"])).toThrow(/invalid claim "src\/util.ts"; use path:line/);
    expect(() => parseClaims(["src/util.ts:0"])).toThrow(/invalid claim/);
    const ambiguous = plumb(index, "compute", []);
    expect(["found", "ambiguous"]).toContain(ambiguous.status);
  });
});

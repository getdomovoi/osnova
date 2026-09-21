import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import type { FileCard, OsnovaEdge, OsnovaSymbol } from "../src/types.js";
import { callersDetailed } from "../src/query/callers.js";
import { map } from "../src/query/map.js";
import { formatReach, reachCounter, reachDepthTwoCap } from "../src/query/reach.js";
import { taskContext } from "../src/query/task-context.js";
import { formatCallersDetailed, formatCallersDetailedBounded, formatMap, formatTaskContext } from "../src/query/format.js";

function card(path: string, names: string[]): FileCard {
  const text = `${names.map((name) => `function ${name}() { return 1; }`).join("\n")}\n`;
  const symbols: OsnovaSymbol[] = names.map((name, i) => ({ name, qualifiedName: `${path}#${name}`, file: path,
    kind: "function", signature: `function ${name}()`, lineCount: 1,
    span: { startLine: i + 1, endLine: i + 1, startCol: 0, endCol: (text.split("\n")[i] ?? "").length } }));
  return { path, symbols, text, hash: createHash("sha256").update(text).digest("hex"),
    language: "typescript", size: text.length, lineCount: text.split("\n").length };
}
function edge(from: string, to: string, line = 1, kind: OsnovaEdge["kind"] = "calls"): OsnovaEdge {
  return { kind, fromFile: from.split("#")[0]!, fromSymbol: from, toName: to.split("#")[1]!,
    toSymbol: to, toFile: to.split("#")[0]!, line,
    evidence: { source: "syntax", resolution: { status: "resolved", method: "import-binding" } } };
}
function unresolved(fromFile: string, fromSymbol: string, toName: string): OsnovaEdge {
  return { kind: "calls", fromFile, fromSymbol, toName, line: 9,
    evidence: { source: "syntax", resolution: { status: "unresolved", reason: "no-matching-symbol" } } };
}
function fileImport(fromFile: string, toFile: string): OsnovaEdge {
  return { kind: "imports", fromFile, fromSymbol: "", toName: toFile, toFile, line: 1,
    evidence: { source: "syntax", resolution: { status: "resolved", method: "import-path" } } };
}
function index(files: FileCard[], edges: OsnovaEdge[]): OsnovaIndexImpl {
  return new OsnovaIndexImpl("/fixture", new Map(files.map((file) => [file.path, file])), edges);
}

const files = [
  card("src/a.ts", ["target", "other"]), card("src/x/b.ts", ["b"]), card("src/y/c.ts", ["c"]), card("src/y/d.ts", ["d"]),
  card("src/z/top.ts", ["top"]), card("src/u.ts", ["u"]), card("test/a.test.ts", ["checksTarget"]), card("test/b.test.ts", ["importsOnly"]),
];
const edges = [
  edge("src/x/b.ts#b", "src/a.ts#target", 1), edge("src/x/b.ts#b", "src/a.ts#target", 2),
  edge("src/y/c.ts#c", "src/a.ts#target", 1), edge("src/y/d.ts#d", "src/y/c.ts#c", 1),
  edge("src/z/top.ts#top", "src/x/b.ts#b", 1), edge("src/z/top.ts#top", "src/y/c.ts#c", 2),
  edge("test/a.test.ts#checksTarget", "src/a.ts#target", 4),
  fileImport("test/b.test.ts", "src/a.ts"),
  unresolved("src/u.ts", "src/u.ts#u", "target"), unresolved("src/u.ts", "src/u.ts#u", "elsewhere"),
];
const fixture = index(files, edges);

describe("reach counts", () => {
  it("counts depth-1 edges, files and directories, depth-2 edges once per caller file, same-name unresolved edges and tests", () => {
    const reach = reachCounter(fixture)(fixture.symbols.get("src/a.ts#target")!, { depth: 2 });
    expect(reach.d1).toEqual({ edges: 4, files: 3, dirs: 3 });
    expect(reach.d2).toEqual({ edges: 3, files: 2, capped: false });
    expect(reach.unresolvedSameName).toBe(1);
    expect(reach.tests).toBe(2);
    expect(formatReach(reach)).toBe("reach: d1 callers 4 in 3 files (3 dirs); d2 +3 in 2 files; unresolved same-name 1; tests 2");
  });

  it("omits depth 2 when only depth 1 is requested and prints zero callers without spread", () => {
    const counter = reachCounter(fixture);
    expect(formatReach(counter(fixture.symbols.get("src/a.ts#target")!))).toBe("reach: d1 callers 4 in 3 files (3 dirs); unresolved same-name 1; tests 2");
    expect(formatReach(counter(fixture.symbols.get("src/a.ts#other")!, { depth: 2 }))).toBe("reach: d1 callers 0; unresolved same-name 0; tests 1");
  });

  it("stops the depth-2 walk at the cap and says so", () => {
    const many = Array.from({ length: reachDepthTwoCap + 1 }, (_, i) => card(`src/callers/c${i}.ts`, [`f${i}`]));
    const wide = index([card("src/a.ts", ["target"]), card("src/hub.ts", ["hub"]), ...many], [
      edge("src/hub.ts#hub", "src/a.ts#target"),
      ...many.map((file, i) => edge(`${file.path}#f${i}`, "src/hub.ts#hub")),
    ]);
    const reach = reachCounter(wide)(wide.symbols.get("src/a.ts#target")!, { depth: 2 });
    expect(reach.d2).toEqual({ edges: reachDepthTwoCap, files: reachDepthTwoCap, capped: true });
    expect(formatReach(reach)).toBe(`reach: d1 callers 1 in 1 files (1 dirs); d2 >${reachDepthTwoCap}; unresolved same-name 0; tests 0`);
  });

  it("prints the reach line after the warp symbol line in both layouts", () => {
    const result = callersDetailed(fixture, "src/a.ts#target", { depth: 2 });
    if (result.status !== "found") throw new Error("expected found");
    expect(result.hits).toHaveLength(7);
    const lines = formatCallersDetailed(result).split("\n");
    expect(lines[1]).toBe("function src/a.ts#target: 7 indexed edges");
    expect(lines[2]).toBe("reach: d1 callers 4 in 3 files (3 dirs); d2 +3 in 2 files; unresolved same-name 1; tests 2");
    const bounded = formatCallersDetailedBounded({ ...result, hits: [...result.hits, ...result.hits, ...result.hits, ...result.hits, ...result.hits, ...result.hits] }, 512).split("\n");
    expect(bounded[2]).toBe(lines[2]);
    expect(bounded[3]).toBe("This does not prove absence of callers or that deletion is safe.");
    const lonely = callersDetailed(fixture, "src/a.ts#other");
    if (lonely.status !== "found") throw new Error("expected found");
    expect(formatCallersDetailed(lonely).split("\n").slice(1, 3)).toEqual([
      "src/a.ts#other: no indexed relationships found",
      "reach: d1 callers 0; unresolved same-name 0; tests 1",
    ]);
  });

  it("gives footing seed definitions a depth-1 reach line and related definitions none", () => {
    const result = taskContext(fixture, { task: "change", question: "", symbols: ["src/a.ts#target"] });
    const seed = result.definitions.find((definition) => definition.symbol.qualifiedName === "src/a.ts#target");
    expect(seed?.reach).toEqual({ d1: { edges: 4, files: 3, dirs: 3 }, unresolvedSameName: 1, tests: 2 });
    expect(result.definitions.filter((definition) => definition.symbol.qualifiedName !== "src/a.ts#target").every((definition) => definition.reach === undefined)).toBe(true);
    const text = formatTaskContext(result);
    expect(text).toContain("- src/a.ts#target function lines 1-1\n  reach: d1 callers 4 in 3 files (3 dirs); unresolved same-name 1; tests 2\n  function target() { return 1; }");
    expect(text).not.toContain("d2");
  });

  it("shows the caller file spread on map hotspots", () => {
    const result = map(fixture);
    const target = result.hotspots.find((hotspot) => hotspot.qualifiedName === "src/a.ts#target");
    expect(target).toMatchObject({ inEdges: 4, inFiles: 3, outEdges: 0 });
    expect(formatMap(result)).toContain("  src/a.ts#target (in 4 from 3 files, out 0) src/a.ts:1");
  });
});

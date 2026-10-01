import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyChanges, buildIndex, callersDetailed, loadIndex } from "../src/index.js";
import { formatCallersDetailed } from "../src/query/format.js";
import { deserializeEdges, serializeEdges } from "../src/index/edgeStore.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-overload-arity-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
});

afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

async function write(files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await fs.writeFile(path.join(workspace, file), text);
  }
}

type Index = Awaited<ReturnType<typeof buildIndex>>;
const callsAt = (index: Index, file: string, line: number, toName: string) =>
  index.edges.filter((edge) => edge.kind === "calls" && edge.fromFile === file && edge.line === line && edge.toName === toName);
const choiceAt = (index: Index, file: string, line: number, toName: string) => {
  const found = callsAt(index, file, line, toName);
  expect(found, `${file}:${line} ${toName}`).toHaveLength(1);
  return { toSymbol: found[0]?.toSymbol, arguments: found[0]?.arguments, overload: found[0]?.overload };
};

const gson = [
  /*  1 */ "package p;",
  /*  2 */ "public class Gson {",
  /*  3 */ "  public String toJson(Object src) { return \"\"; }",
  /*  4 */ "  public void toJson(Object src, Appendable writer) { }",
  /*  5 */ "  public void toJson(Object src, Appendable writer, int indent) { }",
  /*  6 */ "  public <T> T fromJson(String json, Class<T> type) { return null; }",
  /*  7 */ "  public <T> T fromJson(String json, java.lang.reflect.Type type) { return null; }",
  /*  8 */ "  public void log(String... parts) { }",
  /*  9 */ "  public void log(int level, String message) { }",
  /* 10 */ "  public void one(int a) { }",
  /* 11 */ "}",
].join("\n");

const use = [
  /*  1 */ "package p;",
  /*  2 */ "public class Use {",
  /*  3 */ "  void run(Gson gson, StringBuilder sb) {",
  /*  4 */ "    gson.toJson(\"x\");",
  /*  5 */ "    gson.toJson(\"x\", sb);",
  /*  6 */ "    gson.fromJson(\"{}\", String.class);",
  /*  7 */ "    gson.toJson();",
  /*  8 */ "    gson.log(\"a\", \"b\", \"c\");",
  /*  9 */ "    gson.log(1, \"two\");",
  /* 10 */ "    gson.one(1, 2);",
  /* 11 */ "    gson.one(1);",
  /* 12 */ "    gson.toJson(\"x\"); gson.toJson(\"x\", sb, /* indent */ 2);",
  /* 13 */ "  }",
  /* 14 */ "}",
].join("\n");

describe("Java overloads chosen by argument count", () => {
  it("names the one overload whose parameters accept the call's argument count", async () => {
    await write({ "src/Gson.java": gson, "src/Use.java": use });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "src/Use.java", 4, "toJson")).toEqual({ toSymbol: "src/Gson.java#Gson.toJson", arguments: 1, overload: { line: 3 } });
    expect(choiceAt(index, "src/Use.java", 5, "toJson")).toEqual({ toSymbol: "src/Gson.java#Gson.toJson", arguments: 2, overload: { line: 4 } });
    expect(choiceAt(index, "src/Use.java", 8, "log")).toEqual({ toSymbol: "src/Gson.java#Gson.log", arguments: 3, overload: { line: 8 } });
  });

  it("keeps the edge but names no overload when the count fits several or none", async () => {
    await write({ "src/Gson.java": gson, "src/Use.java": use });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "src/Use.java", 6, "fromJson")).toEqual({ toSymbol: "src/Gson.java#Gson.fromJson", arguments: 2, overload: { candidates: [6, 7] } });
    expect(choiceAt(index, "src/Use.java", 7, "toJson")).toEqual({ toSymbol: "src/Gson.java#Gson.toJson", arguments: 0, overload: { candidates: [] } });
    expect(choiceAt(index, "src/Use.java", 9, "log")).toEqual({ toSymbol: "src/Gson.java#Gson.log", arguments: 2, overload: { candidates: [8, 9] } });
  });

  it("flags a single declaration that cannot take the call's argument count and leaves a fitting one alone", async () => {
    await write({ "src/Gson.java": gson, "src/Use.java": use });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "src/Use.java", 10, "one")).toEqual({ toSymbol: "src/Gson.java#Gson.one", arguments: 2, overload: { candidates: [] } });
    expect(choiceAt(index, "src/Use.java", 11, "one")).toEqual({ toSymbol: "src/Gson.java#Gson.one", arguments: 1, overload: undefined });
  });

  it("keeps two calls on one line apart when their argument counts differ", async () => {
    await write({ "src/Gson.java": gson, "src/Use.java": use });
    const index = await buildIndex(workspace, { cacheDir });
    const both = callsAt(index, "src/Use.java", 12, "toJson").map((edge) => [edge.arguments, edge.overload]);
    expect(both).toEqual([[1, { line: 3 }], [3, { line: 5 }]]);
  });

  it("records each method's parameter range on its symbol", async () => {
    await write({ "src/Gson.java": gson });
    const index = await buildIndex(workspace, { cacheDir });
    const ranges = index.files.get("src/Gson.java")?.symbols.filter((symbol) => symbol.kind === "method").map((symbol) => [symbol.span.startLine, symbol.parameters]);
    expect(ranges).toEqual([
      [3, { min: 1, max: 1 }], [4, { min: 2, max: 2 }], [5, { min: 3, max: 3 }], [6, { min: 2, max: 2 }], [7, { min: 2, max: 2 }],
      [8, { min: 0 }], [9, { min: 2, max: 2 }], [10, { min: 1, max: 1 }],
    ]);
  });
});

const csharp = [
  /*  1 */ "namespace P {",
  /*  2 */ "  public static class Ext {",
  /*  3 */ "    public static int Count(this string s, int start = 0) { return 0; }",
  /*  4 */ "    public static int Count(this string s, char c, int start, int end) { return 0; }",
  /*  5 */ "  }",
  /*  6 */ "  public class Box {",
  /*  7 */ "    public void Put(int a) { }",
  /*  8 */ "    public void Put(int a, int b, params int[] rest) { }",
  /*  9 */ "    public void Run() {",
  /* 10 */ "      Put(1);",
  /* 11 */ "      Put(1, 2);",
  /* 12 */ "      Put(1, 2, 3, 4);",
  /* 13 */ "      Put();",
  /* 14 */ "      Ext.Count(\"a\");",
  /* 15 */ "      Ext.Count(\"a\", 'c', 1, 2);",
  /* 16 */ "    }",
  /* 17 */ "  }",
  /* 18 */ "}",
].join("\n");

describe("C# overloads chosen by argument count", () => {
  it("counts optional, params and extension parameters", async () => {
    await write({ "src/Box.cs": csharp });
    const index = await buildIndex(workspace, { cacheDir });
    const ranges = index.files.get("src/Box.cs")?.symbols.filter((symbol) => symbol.kind === "method").map((symbol) => [symbol.span.startLine, symbol.parameters]);
    expect(ranges).toEqual([
      [3, { min: 1, max: 2, extension: true }], [4, { min: 4, max: 4, extension: true }],
      [7, { min: 1, max: 1 }], [8, { min: 2 }], [9, { min: 0, max: 0 }],
    ]);
  });

  it("names the overload a call binds by count", async () => {
    await write({ "src/Box.cs": csharp });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "src/Box.cs", 10, "Put").overload).toEqual({ line: 7 });
    expect(choiceAt(index, "src/Box.cs", 11, "Put").overload).toEqual({ line: 8 });
    expect(choiceAt(index, "src/Box.cs", 12, "Put").overload).toEqual({ line: 8 });
    expect(choiceAt(index, "src/Box.cs", 13, "Put").overload).toEqual({ candidates: [] });
    expect(choiceAt(index, "src/Box.cs", 14, "Count")).toEqual({ toSymbol: "src/Box.cs#Ext.Count", arguments: 1, overload: { line: 3 } });
    expect(choiceAt(index, "src/Box.cs", 15, "Count")).toEqual({ toSymbol: "src/Box.cs#Ext.Count", arguments: 4, overload: { line: 4 } });
  });
});

describe("overload choices across the cache and incremental updates", () => {
  it("survives a save and load", async () => {
    await write({ "src/Gson.java": gson, "src/Use.java": use });
    const built = await buildIndex(workspace, { cacheDir });
    const loaded = await loadIndex(workspace, { cacheDir });
    expect(loaded).not.toBeNull();
    expect(loaded?.edges).toEqual(built.edges);
    expect(choiceAt(loaded!, "src/Use.java", 4, "toJson").overload).toEqual({ line: 3 });
  });

  it("re-chooses when the target's overloads change, equal to a full rebuild", async () => {
    await write({ "src/Gson.java": gson, "src/Use.java": use });
    const before = await buildIndex(workspace, { cacheDir });
    await write({ "src/Gson.java": gson.replace("  public void toJson(Object src, Appendable writer) { }", "  public void toJson(Object src, Appendable writer, boolean pretty) { }") });
    const updated = await applyChanges(before, workspace, ["src/Gson.java"]);
    const fresh = await buildIndex(workspace, { cacheDir: path.join(temporary, "fresh-cache") });
    expect(updated.edges).toEqual(fresh.edges);
    expect(choiceAt(updated, "src/Use.java", 5, "toJson").overload).toEqual({ candidates: [] });
  });

  it("re-chooses when only a call's argument count changes, equal to a full rebuild", async () => {
    await write({ "src/Gson.java": gson, "src/Use.java": use });
    const before = await buildIndex(workspace, { cacheDir });
    await write({ "src/Use.java": use.replace("    gson.toJson(\"x\");\n    gson.toJson(\"x\", sb);", "    gson.toJson(\"x\", sb);\n    gson.toJson(\"x\", sb);") });
    const updated = await applyChanges(before, workspace, ["src/Use.java"]);
    const fresh = await buildIndex(workspace, { cacheDir: path.join(temporary, "fresh-cache") });
    expect(updated.edges).toEqual(fresh.edges);
    expect(choiceAt(updated, "src/Use.java", 4, "toJson").overload).toEqual({ line: 4 });
  });
});

describe("stored overload metadata", () => {
  it("refuses a corrupted overload table on load", async () => {
    await write({ "src/Gson.java": gson, "src/Use.java": use });
    const index = await buildIndex(workspace, { cacheDir });
    const paths = [...index.files.keys()].sort();
    const lines = serializeEdges(index.edges, paths).bytes.toString("utf8").split("\n");
    const header = JSON.parse(lines[0]!) as { overloads: unknown[] };
    expect(header.overloads.length).toBeGreaterThan(0);
    for (const corrupt of [{ line: 0 }, { candidates: [7, 6] }, { line: 3, candidates: [] }]) {
      const tampered = [JSON.stringify({ ...header, overloads: [corrupt, ...header.overloads.slice(1)] }), ...lines.slice(1)].join("\n");
      expect(() => deserializeEdges(Buffer.from(tampered), paths, index.files), JSON.stringify(corrupt)).toThrow(/corrupt overload metadata/);
    }
  });
});


describe("warp answers name the overload a call binds", () => {
  it("adds the chosen, undetermined or impossible overload under each caller", async () => {
    await write({ "src/Gson.java": gson, "src/Use.java": use });
    const index = await buildIndex(workspace, { cacheDir });
    const toJson = formatCallersDetailed(callersDetailed(index, "src/Gson.java#Gson.toJson"));
    expect(toJson).toContain("4,12: overload: line 3, chosen by argument count 1");
    expect(toJson).toContain("12: overload: line 5, chosen by argument count 3");
    expect(toJson).toContain("5: overload: line 4, chosen by argument count 2");
    expect(toJson).toContain("7: overload: no declaration takes argument count 0");
    const fromJson = formatCallersDetailed(callersDetailed(index, "src/Gson.java#Gson.fromJson"));
    expect(fromJson).toContain("overload: not determined; argument count 2 fits lines 6, 7");
    const one = formatCallersDetailed(callersDetailed(index, "src/Gson.java#Gson.one"));
    expect(one).toContain("10: overload: no declaration takes argument count 2");
    expect(one).not.toMatch(/11: overload/);
  });

  it("gives a callee the chosen overload's line", async () => {
    await write({ "src/Gson.java": gson, "src/Use.java": use });
    const index = await buildIndex(workspace, { cacheDir });
    const result = callersDetailed(index, "src/Use.java#Use.run", { direction: "out" });
    expect(result.status).toBe("found");
    const toJson = result.status === "found" ? result.hits.filter((hit) => hit.qualifiedName === "src/Gson.java#Gson.toJson").map((hit) => [hit.edge.line, hit.line]) : [];
    expect(toJson).toEqual([[4, 3], [5, 4], [7, 5], [12, 3], [12, 5]]);
  });
});

describe("warp answers for overloads found in a base class", () => {
  const base = ["class Base {", "  void ping() { }", "  void pong(String s) { }", "}"].join("\n");
  const sub = ["class Sub extends Base {", "  void ping(int a) { }", "  void pong(int a) { }", "}"].join("\n");
  const caller = ["class Run {", "  void go(Sub s) {", "    s.ping();", "    s.pong(1);", "  }", "}"].join("\n");

  it("says where a moved edge came from and lists candidates in other files", async () => {
    await write({ "src/Base.java": base, "src/Sub.java": sub, "src/Run.java": caller });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "src/Run.java", 3, "ping").toSymbol).toBe("src/Base.java#Base.ping");
    const ping = formatCallersDetailed(callersDetailed(index, "src/Base.java#Base.ping"));
    expect(ping).toContain("overload: line 2, chosen by argument count 0; moved from src/Sub.java#Sub.ping");
    const pong = formatCallersDetailed(callersDetailed(index, "src/Sub.java#Sub.pong"));
    expect(pong).toContain("overload: not determined; argument count 1 fits lines 3, src/Base.java:3");
  });
});

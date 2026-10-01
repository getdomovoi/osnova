import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyChanges, buildIndex, callersDetailed, loadIndex, serializeArtifact } from "../src/index.js";
import { formatCallersDetailed } from "../src/query/format.js";
import { deserializeEdges, serializeEdges } from "../src/index/edgeStore.js";
import { deserializeArtifact } from "../src/index/serialize.js";

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
      [3, { min: 1, max: 1, types: ["java.lang.Object"], names: ["Object"] }], [4, { min: 2, max: 2, types: ["java.lang.Object", "java.lang.Appendable"], names: ["Appendable", "Object"] }],
      [5, { min: 3, max: 3, types: ["java.lang.Object", "java.lang.Appendable", "int"], names: ["Appendable", "Object"] }], [6, { min: 2, max: 2 }],
      [7, { min: 2, max: 2, types: ["java.lang.String", "java.lang.reflect.Type"], names: ["String"] }], [8, { min: 0, types: ["java.lang.String..."], names: ["String"] }],
      [9, { min: 2, max: 2, types: ["int", "java.lang.String"], names: ["String"] }], [10, { min: 1, max: 1, types: ["int"] }],
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

describe("incremental updates that change only a resolution input outside the symbols", () => {
  const same = async (files: Record<string, string>, edit: Record<string, string>) => {
    await write(files);
    const before = await buildIndex(workspace, { cacheDir });
    await write(edit);
    const updated = await applyChanges(before, workspace, Object.keys(edit));
    const fresh = await buildIndex(workspace, { cacheDir: path.join(temporary, "fresh-cache") });
    expect(updated.edges).toEqual(fresh.edges);
    expect(serializeArtifact(updated).equals(serializeArtifact(fresh))).toBe(true);
    return fresh;
  };

  it("re-resolves when a Java base class moves to another package", async () => {
    const fresh = await same({
      "Base.java": "package p;\npublic class Base {\n  void put() {}\n}\n",
      "Child.java": "package p;\npublic class Child extends Base {\n  public void put(int i) {}\n  public void run() { put(); }\n}\n",
    }, { "Base.java": "package q;\npublic class Base {\n  void put() {}\n}\n" });
    expect(choiceAt(fresh, "Child.java", 4, "put").toSymbol).toBe("Child.java#Child.put");
  });

  it("re-resolves when a C# partial part gains or loses a syntax error", async () => {
    const a = "partial class A\n{\n  public void Put(int x) {}\n  public void Run() { Put(); }\n}\n";
    const clean = "partial class A\n{\n  public void Put()\n  {\n    return;\n  }\n}\n";
    const broken = clean.replace("return;", "return)");
    const afterBreak = await same({ "A.cs": a, "A2.cs": clean }, { "A2.cs": broken });
    expect(choiceAt(afterBreak, "A.cs", 4, "Put").toSymbol).toBe("A.cs#A.Put");
    const afterFix = await same({ "A2.cs": broken }, { "A2.cs": clean });
    expect(choiceAt(afterFix, "A.cs", 4, "Put").toSymbol).toBe("A2.cs#A.Put");
  });
});

describe("stored provenance of a moved overload edge", () => {
  it("refuses a from that names no indexed method", async () => {
    await write({
      "src/Base.java": "class Base {\n  void ping() { }\n}\n",
      "src/Sub.java": "class Sub extends Base {\n  void ping(int a) { }\n}\n",
      "src/Run.java": "class Run {\n  void go(Sub s) {\n    s.ping();\n  }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    const paths = [...index.files.keys()].sort();
    const moved = index.edges.find((edge) => edge.overload !== undefined && "from" in edge.overload && edge.overload.from !== undefined);
    expect(moved?.overload).toEqual({ line: 2, from: "src/Sub.java#Sub.ping" });
    expect(deserializeEdges(serializeEdges(index.edges, paths).bytes, paths, index.files)).toEqual(index.edges);
    for (const from of ["not-indexed.java#No.Such", "src/Sub.java#", "#Sub.ping", "src/Sub.java#Sub..ping", "src/Sub.java#Sub.nothing", "src/Sub.java#Sub"]) {
      const tampered = index.edges.map((edge) => edge === moved ? { ...edge, overload: { line: 2, from } } : edge);
      const store = () => deserializeEdges(serializeEdges(tampered, paths).bytes, paths, index.files);
      expect(store, from).toThrow(/corrupt overload metadata/);
    }
  });
});

describe("C# partial parts are one type only within one namespace and arity", () => {
  it("does not merge partial types of the same name in different namespaces", async () => {
    await write({
      "One.cs": "namespace One {\n partial class Box {\n  public void Put(int x) {}\n  public void Run() { Put(1); Put(); }\n }\n}\n",
      "Two.cs": "namespace Two {\n partial class Box {\n  public void Put(int x, int y = 0) {}\n  public void Put() {}\n }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    const calls = callsAt(index, "One.cs", 4, "Put").map((edge) => [edge.arguments, edge.toSymbol, edge.overload]);
    expect(calls).toEqual([[0, "One.cs#Box.Put", { candidates: [] }], [1, "One.cs#Box.Put", undefined]]);
  });

  it("merges parts in one namespace, block or file-scoped, but not across generic arity", async () => {
    await write({
      "A.cs": "namespace N.M {\n partial class Box {\n  public void Put(int x) {}\n  public void Run() { Put(); }\n }\n}\n",
      "B.cs": "namespace N.M;\npartial class Box {\n  public void Put() {}\n}\n",
      "G.cs": "namespace N.M {\n partial class Box<T> {\n  public void Put(int x, int y) {}\n }\n}\n",
      "U.cs": "namespace N.M {\n class Use {\n  void Go(Box b) { b.Put(1, 2); }\n }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "A.cs", 4, "Put")).toEqual({ toSymbol: "B.cs#Box.Put", arguments: 0, overload: { line: 3, from: "A.cs#Box.Put" } });
    expect(index.files.get("A.cs")?.symbols.find((symbol) => symbol.name === "Box")?.partial).toBe("N.M`0");
    expect(index.files.get("G.cs")?.symbols.find((symbol) => symbol.name === "Box")?.partial).toBe("N.M`1");
  });
});

describe("a Java @Override that may implement an interface method", () => {
  it("does not hide a superclass overload of the same arity", async () => {
    await write({
      "Base.java": "public class Base {\n  public void put(int x) {}\n}\n",
      "I.java": "public interface I {\n  void put(String x);\n}\n",
      "Child.java": "public class Child extends Base implements I {\n  @Override public void put(String x) {}\n  public void put(String x, String y) {}\n}\n",
      "Use.java": "public class Use {\n  public void run(Child child) { child.put(1); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    const call = choiceAt(index, "Use.java", 2, "put");
    expect(call.overload).not.toEqual({ line: 2 });
    expect(call.overload).toEqual({ candidates: [2], elsewhere: [{ file: "Base.java", line: 2 }] });
  });
});

describe("a Java @Override hides the base declaration with the same written parameter types", () => {
  it("still chooses the override when it repeats the base signature in a class that implements an interface", async () => {
    await write({
      "Base.java": "public class Base {\n  public void put(String x) {}\n  public void put(String x, int n) {}\n}\n",
      "I.java": "public interface I {\n  void run();\n}\n",
      "Child.java": "public class Child extends Base implements I {\n  @Override public void put(String s) {}\n  public void run() {}\n}\n",
      "Use.java": "public class Use {\n  public void go(Child child) { child.put(\"a\"); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "Use.java", 2, "put")).toEqual({ toSymbol: "Child.java#Child.put", arguments: 1, overload: undefined });
  });
});

describe("partial identity in the cache", () => {
  it("loads a partial type whose namespace is escaped or not ASCII", async () => {
    await write({
      "A.cs": "namespace @class {\n partial class Box {\n  public void Put() {}\n }\n}\n",
      "B.cs": "namespace Ünïcode.Ü {\n partial class Box<T> {\n  public void Put() {}\n }\n}\n",
    });
    const built = await buildIndex(workspace, { cacheDir });
    const loaded = await loadIndex(workspace, { cacheDir });
    expect(loaded).not.toBeNull();
    expect(built.files.get("A.cs")?.symbols.find((symbol) => symbol.name === "Box")?.partial).toBe("class`0");
    expect(loaded?.files.get("A.cs")?.symbols.find((symbol) => symbol.name === "Box")?.partial).toBe("class`0");
    expect(loaded?.files.get("B.cs")?.symbols.find((symbol) => symbol.name === "Box")?.partial).toBe("Ünïcode.Ü`1");
    expect(loaded?.files.get("B.cs")?.diagnostics ?? []).toEqual([]);
  });
});

describe("nested C# partial types", () => {
  it("keeps the arity of every enclosing type in the part identity", async () => {
    await write({
      "A.cs": "namespace N {\n partial class Outer<T> {\n  public partial class Inner {\n   public void Put(int x) {}\n   public void Run() { Put(1); Put(); }\n  }\n }\n}\n",
      "B.cs": "namespace N {\n partial class Outer<T, U> {\n  public partial class Inner {\n   public void Put(int x, int y = 0) {}\n  }\n }\n}\n",
      "C.cs": "namespace N {\n partial class Outer<T> {\n  public partial class Inner {\n   public void Put() {}\n  }\n }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    const calls = callsAt(index, "A.cs", 5, "Put").map((edge) => [edge.arguments, edge.toSymbol, edge.overload]).sort((a, b) => Number(a[0]) - Number(b[0]));
    expect(calls).toEqual([[0, "C.cs#Outer.Inner.Put", { line: 4, from: "A.cs#Outer.Inner.Put" }], [1, "A.cs#Outer.Inner.Put", undefined]]);
    expect(index.files.get("A.cs")?.symbols.find((symbol) => symbol.qualifiedName === "A.cs#Outer.Inner")?.partial).toBe("N`1.0");
    expect(index.files.get("B.cs")?.symbols.find((symbol) => symbol.qualifiedName === "B.cs#Outer.Inner")?.partial).toBe("N`2.0");
    const loaded = await loadIndex(workspace, { cacheDir });
    expect(loaded?.files.get("A.cs")?.symbols.find((symbol) => symbol.qualifiedName === "A.cs#Outer.Inner")?.partial).toBe("N`1.0");
  });
});

describe("Java written types prove an override only when they name the same type", () => {
  const iface = "public interface I {\n  void put(String x);\n}\n";
  const use = (arg: string) => `public class Use {\n  public void run(Child child) { child.put(${arg}); }\n}\n`;
  const child = (param: string) => `public class Child extends Base implements I {\n  @Override public void put(${param}) {}\n  public void put(String x, String y) {}\n}\n`;

  it("counts array dimensions written after the parameter name", async () => {
    await write({ "Base.java": "public class Base {\n  public void put(String x[]) {}\n}\n", "I.java": iface, "Child.java": child("String x"), "Use.java": use("new String[]{\"x\"}") });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "Use.java", 2, "put").overload).toEqual({ candidates: [2], elsewhere: [{ file: "Base.java", line: 2 }] });
  });

  it("keeps simple names imported from different packages apart", async () => {
    await write({
      "a/Item.java": "package a; public class Item {}\n", "b/Item.java": "package b; public class Item {}\n",
      "Base.java": "import a.Item;\npublic class Base {\n  public void put(Item x) {}\n}\n",
      "I.java": "import b.Item;\npublic interface I {\n  void put(Item x);\n}\n",
      "Child.java": "import b.Item;\npublic class Child extends Base implements I {\n  @Override public void put(Item x) {}\n  public void put(Item x, Item y) {}\n}\n",
      "Use.java": "public class Use {\n  public void run(Child child, a.Item item) { child.put(item); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "Use.java", 2, "put").overload).toEqual({ candidates: [3], elsewhere: [{ file: "Base.java", line: 3 }] });
  });

  it("proves nothing from a type variable", async () => {
    await write({
      "Base.java": "public class Base<T extends CharSequence> {\n  public void put(T x) {}\n}\n",
      "I.java": "public interface I<T extends Number> {\n  void put(T x);\n}\n",
      "Child.java": "public class Child<T extends Number> extends Base<String> implements I<T> {\n  @Override public void put(T x) {}\n  public void put(T x, T y) {}\n}\n",
      "Use.java": "public class Use {\n  public void run(Child<Integer> child) { child.put(\"x\"); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "Use.java", 2, "put").overload).toEqual({ candidates: [2], elsewhere: [{ file: "Base.java", line: 2 }] });
    expect(index.files.get("Child.java")?.symbols.find((symbol) => symbol.span.startLine === 2)?.parameters?.types).toBeUndefined();
  });

  it("still lets a same-package override hide the base method it repeats", async () => {
    await write({
      "p/Item.java": "package p; public class Item {}\n",
      "p/Base.java": "package p;\npublic class Base {\n  public void put(Item x) {}\n  public void put(Item x, String y) {}\n}\n",
      "p/I.java": "package p;\npublic interface I {\n  void run();\n}\n",
      "p/Child.java": "package p;\npublic class Child extends Base implements I {\n  @Override public void put(Item item) {}\n  public void run() {}\n}\n",
      "p/Use.java": "package p;\npublic class Use {\n  public void go(Child child, Item item) { child.put(item); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "p/Use.java", 3, "put")).toEqual({ toSymbol: "p/Child.java#Child.put", arguments: 1, overload: undefined });
    expect(index.files.get("p/Child.java")?.symbols.find((symbol) => symbol.span.startLine === 3)?.parameters?.types).toEqual(["p.Item"]);
  });
});

describe("a Java simple type name proves nothing that another file can shadow", () => {
  it("does not let a same-package class pass as the java.lang type of the same name", async () => {
    await write({
      "q/Base.java": "package q;\npublic class Base {\n  public void put(java.lang.String x) {}\n}\n",
      "p/String.java": "package p;\npublic class String {}\n",
      "p/I.java": "package p;\npublic interface I {\n  void put(String x);\n}\n",
      "p/Child.java": "package p;\nimport q.Base;\npublic class Child extends Base implements I {\n  @Override public void put(String x) {}\n  public void put(String x, String y) {}\n}\n",
      "p/Use.java": "package p;\npublic class Use {\n  public void run(Child child, java.lang.String x) { child.put(x); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "p/Use.java", 3, "put").overload).toEqual({ candidates: [4], elsewhere: [{ file: "q/Base.java", line: 3 }] });
  });

  it("does not let an inherited nested type pass as the package type of the same name", async () => {
    await write({
      "q/Base.java": "package q;\npublic class Base {\n  public static class Nested {}\n  public void put(p.Nested x) {}\n}\n",
      "p/Nested.java": "package p;\npublic class Nested {}\n",
      "p/I.java": "package p;\nimport q.Base;\npublic interface I {\n  void put(Base.Nested x);\n}\n",
      "p/Child.java": "package p;\nimport q.Base;\npublic class Child extends Base implements I {\n  @Override public void put(Nested x) {}\n  public void put(Nested x, int y) {}\n}\n",
      "p/Use.java": "package p;\npublic class Use {\n  public void run(Child child, p.Nested x) { child.put(x); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "p/Use.java", 3, "put").overload).toEqual({ candidates: [4], elsewhere: [{ file: "q/Base.java", line: 4 }] });
  });

  it("reads a wildcard bound written with spaces as the same type as its qualified form", async () => {
    await write({
      "a/Item.java": "package a;\npublic class Item {}\n",
      "q/Base.java": "package q;\npublic class Base {\n  public void put(java.util.List<? extends a.Item> x) {}\n}\n",
      "p/Child.java": "package p;\nimport q.Base;\nimport java.util.List;\nimport a.Item;\npublic class Child extends Base {\n  @Override public void put(List<? extends Item> x) {}\n  public void put(List<Item> x, int y) {}\n}\n",
      "p/Use.java": "package p;\npublic class Use {\n  public void run(Child child, java.util.List<? extends a.Item> x) { child.put(x); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "p/Use.java", 3, "put")).toEqual({ toSymbol: "p/Child.java#Child.put", arguments: 1, overload: { line: 6 } });
  });
});

describe("what a Java simple name proof follows", () => {
  const item = "package p;\npublic class Item {}\n";
  const base = "package p;\npublic class Base {\n  public void put(Item x) {}\n}\n";
  const use = "package p;\npublic class Use {\n  public void run(Child child, p.Item x) { child.put(x); }\n}\n";

  it("counts a nested type of an implemented interface as shadowing the name", async () => {
    await write({
      "p/Item.java": item, "p/Base.java": base, "p/Use.java": use,
      "p/Mark.java": "package p;\npublic interface Mark {\n  class Item {}\n  void put(Mark.Item x);\n}\n",
      "p/Child.java": "package p;\npublic class Child extends Base implements Mark {\n  @Override public void put(Item x) {}\n  public void put(Item x, int y) {}\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "p/Use.java", 3, "put").overload).toEqual({ candidates: [3], elsewhere: [{ file: "p/Base.java", line: 3 }] });
  });

  it("leaves the name unproven when a written interface names no indexed type", async () => {
    await write({
      "p/Item.java": item, "p/Base.java": base, "p/Use.java": use,
      "q/Mark.java": "package q;\npublic interface Mark {\n  class Item {}\n  void put(Mark.Item x);\n}\n",
      "p/Child.java": "package p;\npublic class Child extends Base implements q.Mark {\n  @Override public void put(Item x) {}\n  public void put(Item x, int y) {}\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "p/Use.java", 3, "put").overload).toEqual({ candidates: [3], elsewhere: [{ file: "p/Base.java", line: 3 }] });
  });

  it("re-chooses when a shadowing type is added to the package, equal to a full rebuild", async () => {
    await write({
      "q/Base.java": "package q;\npublic class Base {\n  public void put(java.lang.String x) {}\n}\n",
      "p/I.java": "package p;\npublic interface I {\n  void put(String x);\n}\n",
      "p/Child.java": "package p;\nimport q.Base;\npublic class Child extends Base implements I {\n  @Override public void put(String x) {}\n  public void put(String x, String y) {}\n}\n",
      "p/Use.java": "package p;\npublic class Use {\n  public void run(Child child, java.lang.String x) { child.put(x); }\n}\n",
    });
    const before = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(before, "p/Use.java", 3, "put").overload).toEqual({ line: 4 });
    await write({ "p/String.java": "package p;\npublic class String {}\n" });
    const updated = await applyChanges(before, workspace, ["p/String.java"]);
    const fresh = await buildIndex(workspace, { cacheDir: path.join(temporary, "fresh-cache") });
    expect(updated.edges).toEqual(fresh.edges);
    expect(serializeArtifact(updated).equals(serializeArtifact(fresh))).toBe(true);
    expect(choiceAt(updated, "p/Use.java", 3, "put").overload).toEqual({ candidates: [4], elsewhere: [{ file: "q/Base.java", line: 3 }] });
  });

  it("refuses corrupted names, supertype counts and interface bindings on load", async () => {
    await write({ "C.java": "public class C extends B implements I {\n  public void put(String x) {}\n}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    type Stored = { files: { symbols: { supertypes?: unknown; interfaces?: unknown; parameters?: { types?: unknown; names?: unknown } }[] }[] };
    const corrupt = (change: (symbols: Stored["files"][number]["symbols"]) => void): string => {
      const data = JSON.parse(serializeArtifact(index).toString()) as Stored;
      change(data.files[0]!.symbols);
      return JSON.stringify(data);
    };
    expect(() => deserializeArtifact(corrupt(() => undefined), undefined)).not.toThrow(/corrupt/);
    for (const change of [
      (symbols: Stored["files"][number]["symbols"]) => { symbols[1]!.parameters!.names = ["String", "Item"]; },
      (symbols: Stored["files"][number]["symbols"]) => { symbols[1]!.parameters!.names = ["a b"]; },
      (symbols: Stored["files"][number]["symbols"]) => { delete symbols[1]!.parameters!.types; },
      (symbols: Stored["files"][number]["symbols"]) => { symbols[0]!.supertypes = 0; },
      (symbols: Stored["files"][number]["symbols"]) => { symbols[0]!.supertypes = 1.5; },
      (symbols: Stored["files"][number]["symbols"]) => { symbols[0]!.interfaces = [{ kind: "member", name: "I" }]; },
      (symbols: Stored["files"][number]["symbols"]) => { symbols[0]!.interfaces = [{ kind: "local", name: "I" }, { kind: "local", name: "J" }, { kind: "local", name: "K" }]; },
      (symbols: Stored["files"][number]["symbols"]) => { delete symbols[0]!.supertypes; },
    ]) expect(() => deserializeArtifact(corrupt(change), undefined)).toThrow(/corrupt/);
  });
});

describe("a Java supertype the walk follows is the type the compiler binds", () => {
  it("does not take a same-named type of another package for an unindexed same-package interface", async () => {
    await write({
      "p/Item.java": "package p;\npublic class Item {}\n",
      "q/Base.java": "package q;\npublic class Base {\n  public void put(p.Item x) {}\n}\n",
      "q/External.java": "package q;\npublic interface External {}\n",
      "p/Child.java": "package p;\nimport q.Base;\npublic class Child extends Base implements External {\n  @Override public void put(Item x) {}\n  public void put(Item x, int y) {}\n}\n",
      "p/Use.java": "package p;\npublic class Use {\n  public void run(Child child, p.Item x) { child.put(x); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "p/Use.java", 3, "put").overload).toEqual({ candidates: [4], elsewhere: [{ file: "q/Base.java", line: 3 }] });
  });

  it("names no Java declaration when a written superclass is outside the index", async () => {
    await write({
      "p/Child.java": "package p;\npublic class Child extends Missing {\n  public void put(int x) {}\n  public void put(int x, int y) {}\n}\n",
      "p/Use.java": "package p;\npublic class Use {\n  public void run(Child child) { child.put(1); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "p/Use.java", 3, "put").overload).toEqual({ candidates: [3] });
  });

  it("names no C# declaration when a written base is outside the index", async () => {
    await write({ "Child.cs": "class Child : Missing {\n  public void Put(int x) {}\n  public void Put(int x, int y) {}\n  void Run() { Put(1); }\n}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "Child.cs", 4, "Put").overload).toEqual({ candidates: [2] });
  });

  it("takes a nested base that an enclosing type inherits over a same-package type of that name", async () => {
    await write({
      "q/Grand.java": "package q;\npublic class Grand {\n  public static class Base {\n    public void put(int x) {}\n  }\n}\n",
      "p/Base.java": "package p;\npublic class Base {\n  public void put(String x) {}\n}\n",
      "p/I.java": "package p;\npublic interface I {\n  void put(String x);\n}\n",
      "p/Outer.java": "package p;\nimport q.Grand;\npublic class Outer extends Grand {\n  public class Inner extends Base implements I {\n    @Override public void put(String x) {}\n    public void put(String x, String y) {}\n    public void run() { put(1); }\n  }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "p/Outer.java", 7, "put")).toEqual({ toSymbol: "p/Outer.java#Outer.Inner.put", arguments: 1, overload: { candidates: [5], elsewhere: [{ file: "q/Grand.java", line: 4 }] } });
  });

  it("follows a superclass written as a qualified name", async () => {
    await write({
      "q/Base.java": "package q;\npublic class Base {\n  public void put(int x) {}\n}\n",
      "p/I.java": "package p;\npublic interface I {\n  void put(String x);\n}\n",
      "p/Child.java": "package p;\npublic class Child extends q.Base implements I {\n  @Override public void put(String x) {}\n  public void put(String x, String y) {}\n}\n",
      "p/Use.java": "package p;\npublic class Use {\n  public void run(Child child) { child.put(1); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "p/Use.java", 3, "put")).toEqual({ toSymbol: "p/Child.java#Child.put", arguments: 1, overload: { candidates: [3], elsewhere: [{ file: "q/Base.java", line: 3 }] } });
  });
});

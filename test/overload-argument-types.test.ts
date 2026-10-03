import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyChanges, buildIndex, loadIndex, serializeArtifact } from "../src/index.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-argument-types-"));
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
const overloadsAt = (index: Index, file: string, line: number, name?: string) =>
  index.edges.filter((edge) => edge.kind === "calls" && edge.fromFile === file && edge.line === line && edge.arguments !== undefined && (name === undefined || edge.toName === name))
    .map((edge) => edge.overload);

const gson = [
  "package p;",
  "import java.io.Reader;",
  "import java.io.StringReader;",
  "import java.lang.reflect.Type;",
  "class Gson {",
  "  <T> T fromJson(String json, Class<T> classOfT) { return null; }",
  "  <T> T fromJson(String json, Type typeOfT) { return null; }",
  "  <T> T fromJson(Reader json, Class<T> classOfT) { return null; }",
  "  <T> T fromJson(Reader json, Type typeOfT) { return null; }",
  "  String text() { return null; }",
  "  void use(Type t) {",
  "    fromJson(\"{}\", Gson.class);",
  "    fromJson(\"{}\", t);",
  "    StringReader r = new StringReader(\"x\");",
  "    fromJson(r, Gson.class);",
  "    fromJson(r, t);",
  "    fromJson(text(), t);",
  "    fromJson(null, t);",
  "  }",
  "}",
  "",
].join("\n");

describe("a Java overload chosen by the written argument types", () => {
  it("names the declaration a literal, a class literal, a parameter or a local's declared type selects", async () => {
    await write({ "p/Gson.java": gson });
    const index = await buildIndex(workspace, { cacheDir });
    expect(overloadsAt(index, "p/Gson.java", 12)).toEqual([{ line: 6, types: true }]);
    expect(overloadsAt(index, "p/Gson.java", 13)).toEqual([{ line: 7, types: true }]);
    expect(overloadsAt(index, "p/Gson.java", 15)).toEqual([{ line: 8, types: true }]);
    expect(overloadsAt(index, "p/Gson.java", 16)).toEqual([{ line: 9, types: true }]);
  });

  it("leaves the choice open when an argument's type is not written and could change it", async () => {
    await write({ "p/Gson.java": gson });
    const index = await buildIndex(workspace, { cacheDir });
    // `text()` returns String, but a call's result type is not read: String and Reader both stay possible, so every
    // declaration the count accepts stays listed.
    expect(overloadsAt(index, "p/Gson.java", 17, "fromJson")).toEqual([{ candidates: [6, 7, 8, 9] }]);
    // `null` fits both String and Reader, and neither is more specific than the other.
    expect(overloadsAt(index, "p/Gson.java", 18, "fromJson")).toEqual([{ candidates: [6, 7, 8, 9] }]);
  });

  it("prefers strict invocation over boxing, and fixed arity over varargs", async () => {
    await write({
      "p/A.java": [
        "package p;",
        "class A {",
        "  void m(long x) {}",
        "  void m(Integer x) {}",
        "  void v(String a, String b) {}",
        "  void v(String... rest) {}",
        "  void run() { m(1); v(\"a\", \"b\"); v(\"a\"); }",
        "}",
        "",
      ].join("\n"),
    });
    const index = await buildIndex(workspace, { cacheDir });
    const edges = index.edges.filter((edge) => edge.fromFile === "p/A.java" && edge.line === 7).map((edge) => [edge.toName, edge.arguments, edge.overload]);
    expect(edges).toContainEqual(["m", 1, { line: 3, types: true }]);
    expect(edges).toContainEqual(["v", 2, { line: 5, types: true }]);
    // One argument fits only v(String...): the count alone chose it.
    expect(edges).toContainEqual(["v", 1, { line: 6 }]);
  });

  it("erases a type variable to its bound", async () => {
    await write({
      "p/A.java": [
        "package p;",
        "import java.io.Reader;",
        "import java.io.StringReader;",
        "class A {",
        "  <T extends Reader> void m(T in) {}",
        "  void m(String in) {}",
        "  void run() { m(new StringReader(\"x\")); m(\"x\"); }",
        "}",
        "",
      ].join("\n"),
    });
    const index = await buildIndex(workspace, { cacheDir });
    // Both calls sit on one line and bind different declarations, so both edges stay.
    expect(overloadsAt(index, "p/A.java", 7, "m")).toHaveLength(2);
    expect(overloadsAt(index, "p/A.java", 7, "m")).toEqual(expect.arrayContaining([{ line: 5, types: true }, { line: 6, types: true }]));
  });

  it("chooses among constructors and walks indexed supertypes", async () => {
    await write({
      "p/Element.java": "package p;\nabstract class Element {}\n",
      "p/Primitive.java": "package p;\nclass Primitive extends Element {}\n",
      "p/Box.java": [
        "package p;",
        "class Box {",
        "  Box(Element e) {}",
        "  Box(String s) {}",
        "  static void run() { new Box(new Primitive()); new Box(\"s\"); }",
        "}",
        "",
      ].join("\n"),
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(overloadsAt(index, "p/Box.java", 5, "Box")).toHaveLength(2);
    expect(overloadsAt(index, "p/Box.java", 5, "Box")).toEqual(expect.arrayContaining([{ line: 3, types: true }, { line: 4, types: true }]));
  });

  it("does not choose when a base type outside the index may declare another overload", async () => {
    await write({
      "p/A.java": [
        "package p;",
        "import lib.Base;",
        "class A extends Base {",
        "  void m(String s) {}",
        "  void m(Integer i) {}",
        "  void run() { m(\"s\"); }",
        "}",
        "",
      ].join("\n"),
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(overloadsAt(index, "p/A.java", 6)[0]).not.toEqual({ line: 4, types: true });
  });

  it("does not trust an argument type an inherited nested type can shadow", async () => {
    await write({
      "p/Foo.java": "package p;\nclass Foo {}\n",
      "p/Base.java": "package p;\nclass Base {\n  static class Foo {}\n}\n",
      "p/A.java": [
        "package p;",
        "class A extends Base {",
        "  void m(p.Foo f) {}",
        "  void m(Object o) {}",
        "  void run() { m(new Foo()); }",
        "}",
        "",
      ].join("\n"),
    });
    const index = await buildIndex(workspace, { cacheDir });
    // `Foo` here is Base.Foo, which only m(Object) accepts; the index must not take it for p.Foo.
    expect(overloadsAt(index, "p/A.java", 5)[0]).not.toEqual({ line: 3, types: true });
  });

  it("survives a save and load, and an incremental update equals a full rebuild", async () => {
    await write({ "p/Gson.java": gson });
    const index = await buildIndex(workspace, { cacheDir });
    const loaded = await loadIndex(workspace, { cacheDir });
    expect(loaded).toBeDefined();
    expect(serializeArtifact(loaded!).equals(serializeArtifact(index))).toBe(true);
    await fs.writeFile(path.join(workspace, "p/Gson.java"), gson.replace("<T> T fromJson(Reader json, Type typeOfT) { return null; }", "<T> T fromJson(Object json, Type typeOfT) { return null; }"));
    const changed = await applyChanges(index, workspace, ["p/Gson.java"]);
    const full = await buildIndex(workspace, { cacheDir: path.join(temporary, "full") });
    expect(serializeArtifact(changed).equals(serializeArtifact(full))).toBe(true);
  });
});

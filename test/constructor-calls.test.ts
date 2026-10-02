import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyChanges, buildIndex, loadIndex, serializeArtifact } from "../src/index.js";
import { deserializeEdges, edgeKinds, serializeEdges } from "../src/index/edgeStore.js";
import { deserializeArtifact } from "../src/index/serialize.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-constructor-calls-"));
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
const creationAt = (index: Index, file: string, line: number) => {
  const found = index.edges.filter((edge) => edge.kind === "calls" && edge.fromFile === file && edge.line === line);
  expect(found, `${file}:${line}`).toHaveLength(1);
  const edge = found[0]!;
  return { toName: edge.toName, toSymbol: edge.toSymbol, constructs: edge.constructs, arguments: edge.arguments, overload: edge.overload, status: edge.evidence?.source === "syntax" ? edge.evidence.resolution.status : undefined };
};

const box = [
  /*  1 */ "package p;",
  /*  2 */ "public class Box<T> {",
  /*  3 */ "  public Box(int size) { }",
  /*  4 */ "  public Box(String label, int size) { }",
  /*  5 */ "  public Box(String label, String note) { }",
  /*  6 */ "  public void put(T value) { }",
  /*  7 */ "}",
].join("\n");

const plain = [
  /*  1 */ "package p;",
  /*  2 */ "public class Plain {",
  /*  3 */ "  public void run() { }",
  /*  4 */ "}",
].join("\n");

const failure = [
  /*  1 */ "package p;",
  /*  2 */ "public class Failure extends RuntimeException {",
  /*  3 */ "  public Failure(String message) { super(message); }",
  /*  4 */ "  public Failure(String message, Throwable cause) { super(message, cause); }",
  /*  5 */ "}",
].join("\n");

const javaUse = [
  /*  1 */ "package q;",
  /*  2 */ "import p.Box;",
  /*  3 */ "import p.Plain;",
  /*  4 */ "import p.Failure;",
  /*  5 */ "public class Use {",
  /*  6 */ "  void run() {",
  /*  7 */ "    Box<String> a = new Box<>(1);",
  /*  8 */ "    Box<String> b = new Box<String>(\"x\", 2);",
  /*  9 */ "    Box<String> c = new Box<>(2);",
  /* 10 */ "    Plain d = new Plain();",
  /* 11 */ "    Box<String> e = new Box<>(1) { };",
  /* 12 */ "    throw new Failure(\"boom\");",
  /* 13 */ "  }",
  /* 14 */ "}",
].join("\n");

const java = { "p/Box.java": box, "p/Plain.java": plain, "p/Failure.java": failure, "q/Use.java": javaUse };

describe("Java object creation", () => {
  it("names the constructor the argument count selects", async () => {
    await write(java);
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "q/Use.java", 7)).toEqual({ toName: "Box", toSymbol: "p/Box.java#Box.Box", constructs: "instance", arguments: 1, overload: { line: 3 }, status: "resolved" });
    expect(creationAt(index, "q/Use.java", 9)).toEqual({ toName: "Box", toSymbol: "p/Box.java#Box.Box", constructs: "instance", arguments: 1, overload: { line: 3 }, status: "resolved" });
  });

  it("names no constructor when several take the argument count", async () => {
    await write(java);
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "q/Use.java", 8)).toMatchObject({ toName: "Box", toSymbol: "p/Box.java#Box.Box", constructs: "instance", arguments: 2, overload: { candidates: [4, 5] } });
  });

  it("names the type when it declares no constructor", async () => {
    await write(java);
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "q/Use.java", 10)).toEqual({ toName: "Plain", toSymbol: "p/Plain.java#Plain", constructs: "instance", arguments: 0, overload: undefined, status: "resolved" });
  });

  it("names the type for an anonymous class", async () => {
    await write(java);
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "q/Use.java", 11)).toMatchObject({ toName: "Box", toSymbol: "p/Box.java#Box", constructs: "anonymous", overload: undefined, status: "resolved" });
  });

  it("does not withdraw a constructor because the type's base is outside the index", async () => {
    await write(java);
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "q/Use.java", 12)).toMatchObject({ toSymbol: "p/Failure.java#Failure.Failure", constructs: "instance", overload: { line: 3 } });
  });
});

const csharpBox = [
  /*  1 */ "namespace P {",
  /*  2 */ "  public class Box<T> {",
  /*  3 */ "    public Box(int size) { }",
  /*  4 */ "    public Box(string label, int size) { }",
  /*  5 */ "  }",
  /*  6 */ "  public class Plain { }",
  /*  7 */ "}",
].join("\n");

const csharpUse = [
  /*  1 */ "using P;",
  /*  2 */ "namespace Q {",
  /*  3 */ "  class Use {",
  /*  4 */ "    void Run() {",
  /*  5 */ "      var a = new Box<string>(1);",
  /*  6 */ "      var b = new P.Box<string>(\"x\", 2);",
  /*  7 */ "      var c = new Plain();",
  /*  8 */ "    }",
  /*  9 */ "  }",
  /* 10 */ "}",
].join("\n");

describe("C# object creation", () => {
  it("names the constructor the argument count selects, and the type when it declares none", async () => {
    await write({ "P/Box.cs": csharpBox, "Q/Use.cs": csharpUse });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Q/Use.cs", 5)).toEqual({ toName: "Box`1", toSymbol: "P/Box.cs#Box.Box", constructs: "instance", arguments: 1, overload: { line: 3 }, status: "resolved" });
    // `P` is an indexed namespace, so `P.Box<string>` names its `Box<T>`.
    expect(creationAt(index, "Q/Use.cs", 6)).toMatchObject({ toName: "P.Box`1", toSymbol: "P/Box.cs#Box.Box", constructs: "instance", arguments: 2, overload: { line: 4 } });
    expect(creationAt(index, "Q/Use.cs", 7)).toMatchObject({ toName: "Plain", toSymbol: "P/Box.cs#Plain", constructs: "instance", arguments: 0, overload: undefined });
  });
});

describe("a creation names only an instance constructor of the type it names", () => {
  it("does not take a Java method named like its class for a constructor", async () => {
    await write({ "T.java": "class T {\n  void T() {}\n  static void use() {\n    new T();\n  }\n}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "T.java", 4)).toMatchObject({ toSymbol: "T.java#T", overload: undefined });
  });

  it("does not take a C# static constructor for an instance constructor", async () => {
    await write({
      "T.cs": "class T {\n  static T() {}\n  static void Use() {\n    new T();\n  }\n}\n",
      "U.cs": "class U {\n  static U() {}\n  public U(int x = 0) {}\n  static void Use() {\n    new U();\n  }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "T.cs", 4)).toMatchObject({ toSymbol: "T.cs#T", overload: undefined });
    expect(creationAt(index, "U.cs", 5)).toMatchObject({ toSymbol: "U.cs#U.U", overload: { line: 3 } });
  });

  it("follows a Java package-qualified name instead of a same-named type in the file", async () => {
    await write({
      "a/b/T.java": "package a.b;\npublic class T {\n  public T(int x) {}\n}\n",
      "Use.java": "class T {\n  T(int x) {}\n}\nclass Use {\n  void use() {\n    new a.b.T(1);\n  }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Use.java", 6)).toMatchObject({ toName: "a.b.T", toSymbol: "a/b/T.java#T.T" });
  });

  it("resolves a Java simple name as javac scopes it: import, then package, then a wildcard import", async () => {
    await write({
      "p2/URL.java": "package p2;\npublic class URL {\n  public URL(String s) {}\n}\n",
      "p3/Item.java": "package p3;\npublic class Item {\n  public Item(int x) {}\n}\n",
      "p/Local.java": "package p;\nclass Local {\n  Local(int x) {}\n}\n",
      "p/Use.java": "package p;\nimport java.net.URL;\nimport p3.*;\nclass Use {\n  void use() throws Exception {\n    new URL(\"x\");\n    new Local(1);\n    new Item(2);\n  }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "p/Use.java", 6)).toMatchObject({ toName: "URL", toSymbol: undefined });
    expect(creationAt(index, "p/Use.java", 7)).toMatchObject({ toSymbol: "p/Local.java#Local.Local" });
    expect(creationAt(index, "p/Use.java", 8)).toMatchObject({ toSymbol: "p3/Item.java#Item.Item" });
  });

  it("leaves a creation through a C# using alias unresolved", async () => {
    await write({
      "Box.cs": "namespace P { public class T { public T(int x) {} } }\n",
      "Other.cs": "namespace Q { public class X { public X(int x) {} } }\n",
      "Use.cs": "using X = P.T;\nclass Use { void Run() {\n  new X(1);\n} }\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Use.cs", 3)).toMatchObject({ toName: "X", toSymbol: undefined });
  });

  it("names the type when it declares a primary or canonical constructor", async () => {
    await write({
      "Types.cs": "record R(int X) {\n  public R(string text) : this(0) {}\n}\nclass C(int x) {\n  public C(string s) : this(0) {}\n}\nclass Test {\n  void Run() {\n    new R(1);\n    new C(1);\n  }\n}\n",
      "R.java": "record R(int x) {\n  R(String text) { this(0); }\n  static void use() {\n    new R(1);\n  }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Types.cs", 9)).toMatchObject({ toSymbol: "Types.cs#R", overload: undefined });
    expect(creationAt(index, "Types.cs", 10)).toMatchObject({ toSymbol: "Types.cs#C", overload: undefined });
    expect(creationAt(index, "R.java", 4)).toMatchObject({ toSymbol: "R.java#R", overload: undefined });
  });

  it("counts the constructors of every part of a C# partial type", async () => {
    await write({
      "A.cs": "namespace P {\n  public partial class T {\n    public T(string s) {}\n    public static void Run() {\n      new T(1);\n    }\n  }\n}\n",
      "B.cs": "namespace P { public partial class T { public T(int x) {} } }\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    // Both parts' constructors take one argument, so the creation names neither.
    expect(creationAt(index, "A.cs", 5)).toMatchObject({ toSymbol: "A.cs#T.T", overload: { candidates: [3], elsewhere: [{ file: "B.cs", line: 1 }] } });
  });

  it("moves a creation to the one constructor that takes the count when it lies in another part", async () => {
    await write({
      "A.cs": "namespace P {\n  public partial class T {\n    public T(string s) {}\n    public static void Run() {\n      new T(1, 2);\n    }\n  }\n}\n",
      "B.cs": "namespace P { public partial class T { public T(int x, int y) {} } }\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "A.cs", 5)).toMatchObject({ toSymbol: "B.cs#T.T", overload: { line: 1, from: "A.cs#T.T" } });
  });

  it("counts no arguments for a C# object initializer without parentheses", async () => {
    await write({ "T.cs": "class T {\n  public T() {}\n  public T(int x) {}\n  public int Init { get; set; }\n  static void Use() {\n    new T { Init = 1 };\n  }\n}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "T.cs", 6)).toMatchObject({ toSymbol: "T.cs#T.T", arguments: 0, overload: { line: 2 } });
  });
});

describe("a creation claims a declaration only where the compiler's binding is proven", () => {
  it("keeps the chosen constructor's line when an excluded declaration shares its name", async () => {
    await write({
      "T.java": "class T {\n  T() {}\n  void T() {}\n  static void use() { new T(); }\n}\n",
      "Types.cs": "class C {\n  public C(int x = 0) {}\n  static C() {}\n  public static void Use() { new C(); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "T.java", 4)).toMatchObject({ toSymbol: "T.java#T.T", overload: { line: 2 } });
    expect(creationAt(index, "Types.cs", 4)).toMatchObject({ toSymbol: "Types.cs#C.C", overload: { line: 2 } });
  });

  it("leaves a Java name unresolved when a local class of that name is declared in an enclosing method", async () => {
    await write({ "Use.java": "class T { T() {} }\nclass Use {\n  void use() {\n    new T();\n    class T { T() {} }\n    new T();\n  }\n}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Use.java", 4)).toMatchObject({ toSymbol: undefined });
    expect(creationAt(index, "Use.java", 6)).toMatchObject({ toSymbol: undefined });
  });

  it("indexes two Java local classes that share a qualified name without naming either", async () => {
    await write({ "Use.java": "class Use {\n  void use() {\n    {\n      class T { T() {} }\n      new T();\n    }\n    {\n      class T { T() {} }\n    }\n  }\n}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Use.java", 5)).toMatchObject({ toSymbol: undefined });
    expect(await loadIndex(workspace, { cacheDir })).not.toBeUndefined();
  });

  it("leaves a creation qualified by an enclosing instance to name resolution", async () => {
    await write({ "Types.java": "class A {\n  class Inner { Inner() {} }\n}\nclass B {\n  class Inner { Inner() {} }\n  void use(A a) { a.new Inner(); }\n}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Types.java", 6)).toMatchObject({ toSymbol: undefined, constructs: undefined });
  });

  it("does not inherit a private member type, or a package one from another package", async () => {
    await write({
      "Types.java": "class A {\n  private static class T { T() {} }\n  protected static class U { U() {} }\n}\nclass B extends A {\n  static void use() { new T(); new U(); }\n}\nclass T { T() {} }\nclass U { U() {} }\n",
      "q/Base.java": "package q;\npublic class Base {\n  static class V { V() {} }\n}\n",
      "p/Sub.java": "package p;\nimport q.Base;\nclass Sub extends Base {\n  static void use() { new V(); }\n}\nclass V { V() {} }\n",
      "q/Near.java": "package q;\nclass Near extends Base {\n  static void use() { new V(); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    const creations = index.edges.filter((edge) => edge.constructs !== undefined && edge.line !== 0).map((edge) => [edge.fromFile, edge.line, edge.toName, edge.toSymbol]);
    expect(creations).toContainEqual(["Types.java", 6, "T", "Types.java#T.T"]);
    expect(creations).toContainEqual(["Types.java", 6, "U", "Types.java#A.U.U"]);
    expect(creations).toContainEqual(["p/Sub.java", 4, "V", "p/Sub.java#V.V"]);
    expect(creations).toContainEqual(["q/Near.java", 3, "V", "q/Base.java#Base.V.V"]);
  });

  it("reads member-type access from modifier tokens, not annotation or comment text", async () => {
    await write({
      "Types.java": "@interface Note { String value(); }\nclass Root {\n  @Note(\"private\") public static class T { public T() {} }\n  public /* private */ static class U { public U() {} }\n}\nclass C extends Root { void use() { new T(); new U(); } }\nclass T { T() {} }\nclass U { U() {} }\n",
      "q/Root.java": "package q;\npublic class Root {\n  @Note(\"public\") static class V { V() {} }\n}\n",
      "p/C.java": "package p;\nimport q.Root;\nclass C extends Root { void use() { new V(); } }\nclass V { V() {} }\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    const creations = index.edges.filter((edge) => edge.constructs !== undefined).map((edge) => [edge.fromFile, edge.line, edge.toName, edge.toSymbol]);
    expect(creations).toContainEqual(["Types.java", 6, "T", "Types.java#Root.T.T"]);
    expect(creations).toContainEqual(["Types.java", 6, "U", "Types.java#Root.U.U"]);
    expect(creations).toContainEqual(["p/C.java", 3, "V", "p/C.java#V.V"]);
  });

  it("resolves a base through an annotated public member type", async () => {
    await write({ "Types.java": "@interface Note { String value(); }\nclass Root {\n  @Note(\"private\") public static class Base { public void ping(int x) {} }\n}\nclass Outer extends Root {\n  static class Child extends Base { void use() { this.ping(1); } }\n}\nclass Base { public void ping(int x) {} }\n" });
    const index = await buildIndex(workspace, { cacheDir });
    const ping = index.edges.filter((edge) => edge.kind === "calls" && edge.toName === "ping" && edge.line === 6);
    expect(ping.map((edge) => edge.toSymbol)).toEqual(["Types.java#Root.Base.ping"]);
  });

  it("returns no member type past the C# base walk's budget", async () => {
    const source = ["class T { public T() {} }", "class B0 { public class T { public T() {} } }",
      ...Array.from({ length: 34 }, (_, i) => `class B${i + 1} : B${i} {}`), "class Use : B34 { void Run() { new T(); } }"].join("\n");
    await write({ "Types.cs": `${source}\n` });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Types.cs", 37)).toMatchObject({ toSymbol: undefined });
  });

  it("does not read a C# alias from a string, equal to a full rebuild after editing it", async () => {
    await write({
      "Holder.cs": "class Holder {\n  void Run() {\n    var s = $\"{@\"using Y = P.T;\"}\";\n  }\n}\n",
      "Box.cs": "namespace P { public class T { public T() {} } }\n",
      "Use.cs": "class X { public X() {} }\nclass Use { void Run() { new X(); } }\n",
    });
    const before = await buildIndex(workspace, { cacheDir });
    expect(creationAt(before, "Use.cs", 2)).toMatchObject({ toSymbol: "Use.cs#X.X" });
    await write({ "Holder.cs": "class Holder {\n  void Run() {\n    var s = $\"{@\"using X = P.T;\"}\";\n  }\n}\n" });
    const updated = await applyChanges(before, workspace, ["Holder.cs"]);
    const fresh = await buildIndex(workspace, { cacheDir: path.join(temporary, "fresh-cache") });
    expect(serializeArtifact(updated).equals(serializeArtifact(fresh))).toBe(true);
    expect(creationAt(updated, "Use.cs", 2)).toMatchObject({ toSymbol: "Use.cs#X.X" });
  });

  it("finds a C# nested type declared in another part of an enclosing partial type", async () => {
    await write({
      "A.cs": "public partial class Gen {\n  void Run() { new Mapping(1); new Gen.Mapping(2); }\n}\n",
      "B.cs": "public partial class Gen {\n  public sealed class Mapping { public Mapping(int x) {} }\n}\n",
      "Use.cs": "class Use { void Run() { new Gen.Mapping(3); } }\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    const found = index.edges.filter((edge) => edge.kind === "calls" && edge.constructs !== undefined).map((edge) => [edge.fromFile, edge.toName, edge.toSymbol]);
    expect(found).toEqual([["A.cs", "Gen.Mapping", "B.cs#Gen.Mapping.Mapping"], ["A.cs", "Mapping", "B.cs#Gen.Mapping.Mapping"], ["Use.cs", "Gen.Mapping", "B.cs#Gen.Mapping.Mapping"]]);
  });

  it("reads Java imports as declarations, not lines", async () => {
    await write({
      "q/T.java": "package q; public class T { public T() {} }\n",
      "r/T.java": "package r; public class T { public T() {} }\n",
      "p/T.java": "package p; public class T { public T() {} }\n",
      "p/Use.java": "package p;\nimport q.T;\n/*\nimport r.T;\n*/\nclass Use {\n  void use() { new T(); }\n}\n",
      "p/Same.java": "package p; import q.T;\nclass Same {\n  void use() { new T(); }\n}\n",
      "p/Static.java": "package p;\nimport static q.Outer.T;\nclass Static {\n  void use() { new T(); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "p/Use.java", 7)).toMatchObject({ toSymbol: "q/T.java#T.T" });
    expect(creationAt(index, "p/Same.java", 3)).toMatchObject({ toSymbol: "q/T.java#T.T" });
    expect(creationAt(index, "p/Static.java", 4)).toMatchObject({ toSymbol: undefined });
  });

  it("leaves a C# creation unresolved when any file declares an alias of that name", async () => {
    await write({
      "Alias.cs": "global using X = P.T;\n",
      "Box.cs": "namespace P { public class T { public T() {} } }\n",
      "Other.cs": "namespace Q { public class X { public X() {} } }\n",
      "Use.cs": "class Use { void Run() { new X(); } }\n",
      "Inner.cs": "namespace R { using Y = P.T;\nclass Use { void Run() { new Y(); } } }\n",
      "Y.cs": "namespace S { public class Y { public Y() {} } }\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Use.cs", 1)).toMatchObject({ toSymbol: undefined });
    expect(creationAt(index, "Inner.cs", 2)).toMatchObject({ toSymbol: undefined });
  });

  it("reads a C# alias name past comments in its directive", async () => {
    await write({
      "Alias.cs": "global using X /* alias */ = P.T;\n",
      "Lead.cs": "global using /* alias */ Y = P.T;\n",
      "Box.cs": "namespace P { public class T { public T() {} } }\n",
      "Other.cs": "namespace Q { public class X { public X() {} }\npublic class Y { public Y() {} } }\n",
      "Use.cs": "class Use {\n  void Run() { new X(); }\n  void Lead() { new Y(); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Use.cs", 2)).toMatchObject({ toSymbol: undefined });
    expect(creationAt(index, "Use.cs", 3)).toMatchObject({ toSymbol: undefined });
  });

  it("does not merge C# partial types of one name with different namespaces or arities", async () => {
    await write({
      "Types.cs": "namespace A {\n  public partial class T {\n    public static void Use() { new T(); }\n  }\n}\nnamespace B {\n  public partial class T {\n    public T() {}\n  }\n}\n",
      "Arity.cs": "public partial class U {\n  public static void Use() { new U(); }\n}\npublic partial class U<TItem> {\n  public U() {}\n}\n",
      "Split.cs": "public partial class V {\n  public static void Use() { new V(1); }\n}\n",
      "SplitB.cs": "public partial class V {\n  public V(int x) {}\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Types.cs", 3)).toMatchObject({ toSymbol: undefined });
    expect(creationAt(index, "Arity.cs", 2)).toMatchObject({ toSymbol: undefined });
    expect(creationAt(index, "Split.cs", 2)).toMatchObject({ toSymbol: "SplitB.cs#V.V" });
  });

  it("does not take a C# nested type from an interface a class implements", async () => {
    await write({
      "Types.cs": "class T { public T() {} }\ninterface I { public class T { public T() {} } }\nclass C : I { public void Use() { new T(); } }\n",
      "Base.cs": "class B { public class N { public N() {} } }\nclass N { public N() {} }\nclass D : B { public void Use() { new N(); } }\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Types.cs", 3)).toMatchObject({ toSymbol: "Types.cs#T.T" });
    expect(creationAt(index, "Base.cs", 3)).toMatchObject({ toSymbol: "Base.cs#B.N.N" });
  });

  it("leaves a C# name unknown when an enclosing holder mixes partial identities", async () => {
    await write({ "Types.cs": "namespace A {\n  public partial class C {\n    public class T { public T() {} }\n  }\n}\nnamespace B {\n  public partial class C {\n    public static void Use() { new T(); }\n  }\n}\nclass T { public T() {} }\n" });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Types.cs", 8)).toMatchObject({ toSymbol: undefined });
  });

  it("keeps a creation of a C# type parameter a plain call", async () => {
    await write({
      "Types.cs": "class T { public T() {} }\nclass U { public U() {} }\nclass C<T> where T : new() {\n  public static object Use() { return new T(); }\n  public static V Make<V>() where V : new() => new V();\n  public static object Local() { W Inner<W>() where W : new() => new W(); return Inner<U>(); }\n}\nclass V { public V() {} }\nclass W { public W() {} }\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    for (const line of [4, 5, 6]) expect(creationAt(index, "Types.cs", line)).toMatchObject({ toSymbol: undefined, constructs: undefined });
  });

  it("matches a C# creation's written generic arity", async () => {
    await write({
      "Types.cs": "class T { public T() {} }\nclass Use {\n  public static void Run() { new T<int>(); new T(); }\n}\n",
      "Generic.cs": "class T<TItem> { public T() {} }\n",
      "Outer.cs": "class Outer<TKey> {\n  public class Inner { public Inner() {} }\n}\n",
      "OuterPlain.cs": "class Outer {\n  public class Inner { public Inner(int x) {} }\n}\n",
      "Nested.cs": "class Nested { void Run() { new Outer<int>.Inner(); } }\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    const creations = index.edges.filter((edge) => edge.constructs !== undefined).map((edge) => [edge.fromFile, edge.line, edge.toName, edge.toSymbol]);
    expect(creations).toContainEqual(["Types.cs", 3, "T`1", "Generic.cs#T.T"]);
    expect(creations).toContainEqual(["Types.cs", 3, "T", "Types.cs#T.T"]);
    expect(creations).toContainEqual(["Nested.cs", 1, "Outer`1.Inner", "Outer.cs#Outer.Inner.Inner"]);
  });

  it("resolves a dotted C# name from its first segment, not by suffix", async () => {
    await write({
      "Box.cs": "namespace P { public class Box { public Box(int x) {} } }\n",
      "Other.cs": "class Other {\n  public class P {\n    public class Box { public Box(int x) {} }\n  }\n  void Run() { new P.Box(1); }\n}\n",
      "Use.cs": "class Use { void Run() { new P.Box(1); new Q.Box(1); } }\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    // `P` is an indexed namespace here; `Q` is not, so it may be one the index does not hold.
    const creations = index.edges.filter((edge) => edge.constructs !== undefined).map((edge) => [edge.fromFile, edge.toName, edge.toSymbol]);
    expect(creations).toContainEqual(["Use.cs", "P.Box", "Box.cs#Box.Box"]);
    expect(creations).toContainEqual(["Use.cs", "Q.Box", undefined]);
    expect(creationAt(index, "Other.cs", 5)).toMatchObject({ toSymbol: "Other.cs#Other.P.Box.Box" });
  });

  it("keeps a C# type-parameter creation unresolved, escaped or not, whatever else shares its name", async () => {
    await write({
      "Types.cs": "class Decoy { public static void T() {} }\nclass C<T> where T : new() {\n  public static object Use() { return new T(); }\n}\n",
      "Escaped.cs": "class U { public U() {} }\nclass D<@U> where U : new() {\n  public static object Use() { return new U(); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Types.cs", 3)).toMatchObject({ toSymbol: undefined, constructs: undefined });
    expect(creationAt(index, "Escaped.cs", 3)).toMatchObject({ toSymbol: undefined, constructs: undefined });
  });

  it("resolves a C# base by its written arity and namespace before searching its member types", async () => {
    await write({
      "Types.cs": "class Base { public class T { public T() {} } }\nclass C : Base<int> {\n  public static object Use() { return new T(); }\n}\nclass T { public T() {} }\n",
      "Generic.cs": "class Base<U> {}\n",
      "Ns.cs": "namespace Q { class Base { public class V { public V() {} } } }\nclass D : P.Base {\n  public static object Use() { return new V(); }\n}\nclass V { public V() {} }\n",
      "PBase.cs": "namespace P { public class Base {} }\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Types.cs", 3)).toMatchObject({ toSymbol: "Types.cs#T.T" });
    expect(creationAt(index, "Ns.cs", 3)).toMatchObject({ toSymbol: "Ns.cs#V.V" });
  });

  it("does not inherit a private C# member type", async () => {
    await write({ "Types.cs": "class A {\n  private class T { public T() {} }\n  class U { public U() {} }\n  protected class W { public W() {} }\n}\nclass B : A {\n  public static object Use() { return new T(); }\n  public static object Other() { new U(); return new W(); }\n}\nclass T { public T() {} }\nclass U { public U() {} }\nclass W { public W() {} }\n" });
    const index = await buildIndex(workspace, { cacheDir });
    const creations = index.edges.filter((edge) => edge.constructs !== undefined).map((edge) => [edge.line, edge.toName, edge.toSymbol]);
    expect(creations).toContainEqual([7, "T", "Types.cs#T.T"]);
    expect(creations).toContainEqual([8, "U", "Types.cs#U.U"]);
    expect(creations).toContainEqual([8, "W", "Types.cs#A.W.W"]);
  });

  it("finds a member type a C# using static directive imports, not an out-of-scope type", async () => {
    await write({
      "Types.cs": "using static P.Holder;\nnamespace Q { public class T { public T(){} } }\nclass C {\n  public static object Use(){return new T();}\n}\n",
      "Actual.cs": "namespace P { public class Holder {\n  public class T { public T(){} }\n} }\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Types.cs", 4)).toMatchObject({ toSymbol: "Actual.cs#Holder.T.T" });
  });

  it("does not read a C# namespace-qualified name as an out-of-scope type chain", async () => {
    await write({ "Types.cs": "namespace P { public class T { public T(){} } }\nnamespace Q {\n  public class P { public class T { public T(){} } }\n}\nclass Use {\n  public static object Run() { return new P.T(); }\n}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Types.cs", 6)).toMatchObject({ toSymbol: "Types.cs#T.T" });
  });

  it("resolves a C# using directive's target from the namespace it is declared in", async () => {
    await write({
      "B.cs": "namespace B{public class T{public T(){}}}\n",
      "AB.cs": "namespace A.B{public class T{public T(){}}}\n",
      "Use.cs": "namespace A {\n  using B;\n  class C{public static object Run(){return new T();}}\n}\n",
      "GlobalHolder.cs": "class Holder { public class U { public U(){} } }\n",
      "AHolder.cs": "namespace A { public class Holder { public class U { public U(){} } } }\n",
      "Static.cs": "namespace A.Inner {\n  using static Holder;\n  class D{public static object Run(){return new U();}}\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Use.cs", 3)).toMatchObject({ toSymbol: "AB.cs#T.T" });
    expect(creationAt(index, "Static.cs", 3)).toMatchObject({ toSymbol: "AHolder.cs#Holder.U.U" });
  });

  it("applies a C# using directive only inside the namespace block that declares it", async () => {
    await write({
      "Global.cs": "class T{public T(){}}\n",
      "Q.cs": "namespace Q{public class T{public T(){}}}\n",
      "Use.cs": "namespace A {\n  using Q;\n  class First{public static object Run(){return new T();}}\n}\nnamespace A {\n  class Second{public static object Run(){return new T();}}\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Use.cs", 3)).toMatchObject({ toSymbol: "Q.cs#T.T" });
    expect(creationAt(index, "Use.cs", 6)).toMatchObject({ toSymbol: "Global.cs#T.T" });
  });

  it("resolves a C# partial type's base in the part that writes it", async () => {
    await write({
      "A.cs": "using Q;\nnamespace N {public partial class C {\n  public static object Run(){return new T();}\n}}\n",
      "B.cs": "using P;\nnamespace N {public partial class C:Base{}}\n",
      "P.cs": "namespace P{public class Base{public class T{public T(){}}}}\n",
      "Q.cs": "namespace Q{public class Base{public class T{public T(){}}}}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "A.cs", 3)).toMatchObject({ toSymbol: "P.cs#Base.T.T" });
  });

  it("reads a C# namespace name past comments", async () => {
    await write({
      "Use.cs": "namespace A /* namespace */ . B {\n  class C{public static object Run(){return new T();}}\n}\n",
      "Actual.cs": "namespace A.B{public class T{public T(){}}}\n",
      "Global.cs": "class T{public T(){}}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Use.cs", 2)).toMatchObject({ toSymbol: "Actual.cs#T.T" });
    expect((await loadIndex(workspace, { cacheDir }))!.files.size).toBe(3);
  });

  it("does not import a protected C# member type through using static", async () => {
    await write({ "Types.cs": "class Holder{protected class T{public T(){}} private protected class U{public U(){}}}\nclass T{public T(){}}\nclass U{public U(){}}\nnamespace N {\n  using static Holder;\n  class C{public static object Run(){new U(); return new T();}}\n}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    const creations = index.edges.filter((edge) => edge.constructs !== undefined).map((edge) => [edge.toName, edge.toSymbol]);
    expect(creations).toContainEqual(["T", "Types.cs#T.T"]);
    expect(creations).toContainEqual(["U", "Types.cs#U.U"]);
  });

  it("reads escaped C# declaration names", async () => {
    await write({
      "Ctor.cs": "class C {\n  public @C(int x){}\n  public C(string x){}\n  public static object Run(){return new C(1);}\n}\n",
      "Nested.cs": "class T{public T(){}}\nclass D {\n  public class @T{public @T(){}}\n  public static object Run(){return new T();}\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    // `@C(int)` and `C(string)` both take one argument, so the count names neither.
    expect(creationAt(index, "Ctor.cs", 4)).toMatchObject({ toSymbol: "Ctor.cs#C.C", overload: { candidates: [2, 3] } });
    expect(creationAt(index, "Nested.cs", 4)).toMatchObject({ toSymbol: "Nested.cs#D.T.T" });
  });

  it("records no base for a C# enum's underlying type, and reads the cache back", async () => {
    await write({ "Types.cs": "enum E : System.Byte { A }\nclass C {public static object Run(){return new C();}}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    expect(index.files.get("Types.cs")!.symbols.find((symbol) => symbol.name === "E")!.baseType).toBeUndefined();
    expect((await loadIndex(workspace, { cacheDir }))!.files.size).toBe(1);
  });

  it("refuses a C# directive's choice on a line two namespace declarations share", async () => {
    await write({
      "Global.cs": "class T{public T(){}}\n",
      "Q.cs": "namespace Q{public class T{public T(){}}}\n",
      "Use.cs": "namespace A {\n using Q; class First{public static object Run(){return new T();}}\n} namespace A {class Second{public static object Run(){return new T();}}\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Use.cs", 2)).toMatchObject({ toSymbol: "Q.cs#T.T" });
    expect(creationAt(index, "Use.cs", 3)).toMatchObject({ toSymbol: undefined });
  });

  it("reads C# identifiers as the compiler does: escapes decoded, formatting characters dropped", async () => {
    await write({
      "Param.cs": "class T {public T(){}}\nclass C<T‌> where T:new() {\n public static object Run(){return new T();}\n}\n",
      "Ns.cs": "namespace P‌ {\n  class D{public static object Run(){return new U();}}\n}\n",
      "Actual.cs": "namespace P{public class U{public U(){}}}\n",
      "Global.cs": "class U{public U(){}}\n",
      "Escape.cs": "class \\u0056 {public V(){}}\nclass E{public static object Run(){return new V();}}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Param.cs", 3)).toMatchObject({ toSymbol: undefined, constructs: undefined });
    expect(creationAt(index, "Ns.cs", 2)).toMatchObject({ toSymbol: "Actual.cs#U.U" });
    // The bundled grammar cannot read a \u escape in an identifier, so that class is not indexed and names nothing.
    expect(creationAt(index, "Escape.cs", 2)).toMatchObject({ toSymbol: undefined });
  });

  it("indexes Unicode C# type names", async () => {
    await write({ "Types.cs": "class Ω {public class T {public T(){}}}\nclass C:Ω {public static object Run(){return new T();}}\nclass T {public T(){}}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Types.cs", 2)).toMatchObject({ toSymbol: "Types.cs#Ω.T.T" });
  });

  it("lets a C# member delegate shadow an outer class without naming either", async () => {
    await write({
      "Types.cs": "using System;\nclass T {public T(Action x){}}\nclass C {\n  public delegate void T();\n  static void M(){}\n  public static object Run(){return new T(M);}\n}\n",
      "Inherited.cs": "using System;\nclass U {public U(Action x){}}\nclass B { public delegate void U(); }\nclass D : B {\n  static void M(){}\n  public static object Run(){return new U(M);}\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Types.cs", 6)).toMatchObject({ toSymbol: undefined });
    expect(creationAt(index, "Inherited.cs", 6)).toMatchObject({ toSymbol: undefined });
  });

  it("names no constructor for a C# delegate that shares its qualified name with a type", async () => {
    await write({
      "Arity.cs": "using System;\nclass C {\n public delegate void T();\n public class T<U> {public T(Action x){}}\n static void M(){}\n public static object Run(){return new T(M);}\n}\n",
      "Reverse.cs": "using System;\nclass D {\n public class V {public V(Action x){}}\n public delegate void V<U>();\n static void M(){}\n public static object Run(){return new V<int>(M);}\n}\n",
      "Ns.cs": "using System;\nnamespace A { public delegate void W(); class E { static void M(){} public static object Run(){return new W(M);} } }\nnamespace B { public class W { public W(Action x){} } }\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Arity.cs", 6)).toMatchObject({ toSymbol: undefined });
    expect(creationAt(index, "Reverse.cs", 6)).toMatchObject({ toSymbol: undefined });
    expect(creationAt(index, "Ns.cs", 2)).toMatchObject({ toSymbol: undefined });
  });

  it("keeps a C# alias named global apart from the global:: qualifier", async () => {
    await write({
      "Use.cs": "using @global = P;\nnamespace N {class C {public static object Run(){return new @global::T();}}}\n",
      "Plain.cs": "namespace M {class D {public static object Run(){return new global::T();}}}\n",
      "Actual.cs": "namespace P {public class T{public T(){}}}\n",
      "Global.cs": "class T{public T(){}}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Use.cs", 2)).toMatchObject({ toSymbol: undefined });
    expect(creationAt(index, "Plain.cs", 1)).toMatchObject({ toSymbol: "Global.cs#T.T" });
  });

  it("imports no member types through a C# delegate named by using static", async () => {
    await write({
      "Types.cs": "delegate void D();\nclass D<U> {public class T {public T(){}}}\nclass T {public T(){}}\nnamespace N {\n using static D;\n class C {public static object Run(){return new T();}}\n}\n",
      "Generic.cs": "class E<U> {public class V {public V(){}}}\nnamespace M {\n using static E<int>;\n class F {public static object Run(){return new V();}}\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Types.cs", 6)).toMatchObject({ toSymbol: "Types.cs#T.T" });
    expect(creationAt(index, "Generic.cs", 4)).toMatchObject({ toSymbol: "Generic.cs#E.V.V" });
  });

  it("keeps an escaped C# primary-constructor type, and refuses a creation outside any type in a file with parse errors", async () => {
    await write({
      "Use.cs": "class @C(int x):B {\n public static object Run(){return new T();}\n}\n",
      "Base.cs": "class B {public class T {public T(){}}}\n",
      "Global.cs": "class T{public T(){}}\n",
      "Lost.cs": "class 1D(int x):B {\n public static object Run(){return new T();}\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Use.cs", 2)).toMatchObject({ toSymbol: "Base.cs#B.T.T" });
    expect(creationAt(index, "Lost.cs", 2)).toMatchObject({ toSymbol: undefined });
  });

  it("reads a C# record's base written with constructor arguments", async () => {
    await write({
      "Use.cs": "record C(int x):B(x) {\n public static object Run(){return new T();}\n}\n",
      "Base.cs": "record B(int x) {public class T {public T(){}}}\n",
      "Global.cs": "class T {public T(){}}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Use.cs", 2)).toMatchObject({ toSymbol: "Base.cs#B.T.T" });
  });

  it("refuses C# creations in a file whose namespace header did not parse", async () => {
    await write({
      "Use.cs": "namespace \\u0050 {\n class C {public static object Run(){return new T();}}\n}\n",
      "Scoped.cs": "namespace \\u0050;\nclass D {public static object Run(){return new T();}}\n",
      "Part.cs": "namespace P\\u0061rt {\n class E {public static object Run(){return new T();}}\n}\n",
      "Actual.cs": "namespace P {class T {public T(){}}}\n",
      "Global.cs": "class T {public T(){}}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Use.cs", 2)).toMatchObject({ toSymbol: undefined });
    expect(creationAt(index, "Scoped.cs", 2)).toMatchObject({ toSymbol: undefined });
    expect(creationAt(index, "Part.cs", 2)).toMatchObject({ toSymbol: undefined });
  });

  it("does not offer another file a type whose namespace header did not parse", async () => {
    await write({
      "Broken.cs": "namespace \\u0050 {\n class T {public T(){}}\n class B {public class V {public V(){}}}\n}\n",
      "Actual.cs": "namespace Q {public class T {public T(){}} public class B {public class V {public V(){}}}}\n",
      "Use.cs": "using Q;\nclass C {public static object Run(){return new T();}}\nclass D:B {public static object Run(){return new V();}}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Use.cs", 2)).toMatchObject({ toSymbol: undefined });
    expect(creationAt(index, "Use.cs", 3)).toMatchObject({ toSymbol: undefined });
  });

  it("reads a C# record base it cannot parse as unknown", async () => {
    await write({
      "Qualified.cs": "record C(int x):P.B(x) {\n public static object Run(){return new T();}\n}\n",
      "Generic.cs": "record D(int x):G<int>(x) {\n public static object Run(){return new T();}\n}\n",
      "Base.cs": "namespace P {public record B(int x) {public class T {public T(){}}}}\nrecord G<U>(int x) {public class T {public T(){}}}\n",
      "Global.cs": "class T {public T(){}}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Qualified.cs", 2)).toMatchObject({ toSymbol: undefined });
    expect(creationAt(index, "Generic.cs", 2)).toMatchObject({ toSymbol: undefined });
  });

  it("refuses any lookup of a C# type name whose declaration header did not parse", async () => {
    await write({
      "Broken.cs": "namespace P {\npublic record C(int x):B<int>(x);\n}\n",
      "Base.cs": "namespace P {public record B<U>(int x);}\n",
      "Use.cs": "namespace P {class Caller {public static object Run(){return new C(1);}}}\nnamespace Q {class Other {public static object Run(){return new C<int>(1);}}}\n",
      "Global.cs": "class C {public C(int x){}}\n",
      "GlobalGeneric.cs": "class C<U> {public C(int x){}}\n",
      "Lost.cs": "namespace \\u0050 {\npublic record D(int x):B<int>(x);\n}\n",
      "Caller.cs": "class E {public static object Run(){return new D(1);}}\nclass D {public D(int x){}}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Use.cs", 1)).toMatchObject({ toSymbol: undefined });
    expect(creationAt(index, "Use.cs", 2)).toMatchObject({ toSymbol: undefined });
    expect(creationAt(index, "Caller.cs", 1)).toMatchObject({ toSymbol: undefined });
  });

  it("does not let C# declarations or directives inside #if decide an active creation", async () => {
    await write({
      "Inactive.cs": "#if false\nclass T {public T(){}}\n#endif\n",
      "Actual.cs": "namespace P {class T {public T(){}} class U {public U(){}}}\n",
      "Use.cs": "using P;\nclass C {public static object Run(){return new T();}}\n",
      "Holder.cs": "class H {\n#if false\npublic class V {public V(){}}\n#endif\n}\n",
      "Inherit.cs": "class D:H {public static object Run(){return new V();}}\nclass V {public V(){}}\n",
      "Scoped.cs": "namespace N {\n#if false\nusing P;\n#endif\nclass E {public static object Run(){return new U();}}\n}\nclass U {public U(){}}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Use.cs", 2)).toMatchObject({ toSymbol: undefined });
    expect(creationAt(index, "Inherit.cs", 1)).toMatchObject({ toSymbol: undefined });
    expect(creationAt(index, "Scoped.cs", 5)).toMatchObject({ toSymbol: undefined });
  });

  it("finds a C# primary constructor behind a comment", async () => {
    await write({ "Types.cs": "class C /* primary */ (int x) {\n  public C(string text) : this(0) {}\n  public static void Use() { new C(1); }\n}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Types.cs", 3)).toMatchObject({ toSymbol: "Types.cs#C", overload: undefined });
  });
});

describe("object creation across the cache and incremental updates", () => {
  it("survives a save and load", async () => {
    await write(java);
    const built = await buildIndex(workspace, { cacheDir });
    const loaded = await loadIndex(workspace, { cacheDir });
    expect(loaded?.edges).toEqual(built.edges);
    expect(creationAt(loaded!, "q/Use.java", 7)).toMatchObject({ constructs: "instance", overload: { line: 3 } });
  });

  it("re-chooses when a constructor is added, equal to a full rebuild", async () => {
    await write(java);
    const before = await buildIndex(workspace, { cacheDir });
    await write({ "p/Plain.java": plain.replace("  public void run() { }", "  public Plain() { }\n  public void run() { }") });
    const updated = await applyChanges(before, workspace, ["p/Plain.java"]);
    const fresh = await buildIndex(workspace, { cacheDir: path.join(temporary, "fresh-cache") });
    expect(serializeArtifact(updated).equals(serializeArtifact(fresh))).toBe(true);
    expect(updated.edges).toEqual(fresh.edges);
    // The one constructor takes the count, so the edge carries no line, as for any single declaration.
    expect(creationAt(updated, "q/Use.java", 10)).toMatchObject({ toSymbol: "p/Plain.java#Plain.Plain", constructs: "instance", overload: undefined });
  });

  it("re-resolves a creation when a type is added to the package, equal to a full rebuild", async () => {
    await write({ "p/Use.java": "package p;\nclass Use {\n  void use() {\n    new Later(1);\n  }\n}\n" });
    const before = await buildIndex(workspace, { cacheDir });
    expect(creationAt(before, "p/Use.java", 4)).toMatchObject({ toSymbol: undefined });
    await write({ "p/Later.java": "package p;\nclass Later {\n  Later(int x) {}\n}\n" });
    const updated = await applyChanges(before, workspace, ["p/Later.java"]);
    const fresh = await buildIndex(workspace, { cacheDir: path.join(temporary, "fresh-cache") });
    expect(serializeArtifact(updated).equals(serializeArtifact(fresh))).toBe(true);
    expect(creationAt(updated, "p/Use.java", 4)).toMatchObject({ toSymbol: "p/Later.java#Later.Later" });
  });

  it("refuses corrupted constructor and primary constructor metadata on load", async () => {
    await write({ "R.java": "record R(int x) {\n  R(String s) { this(0); }\n}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    type Stored = { files: { symbols: { kind: string; primary?: unknown; parameters?: { constructs?: unknown } }[] }[] };
    const corrupt = (change: (symbols: Stored["files"][number]["symbols"]) => void): string => {
      const data = JSON.parse(serializeArtifact(index).toString()) as Stored;
      change(data.files[0]!.symbols);
      return JSON.stringify(data);
    };
    expect(() => deserializeArtifact(corrupt((symbols) => { expect(symbols[0]!.primary).toBe(true); expect(symbols[1]!.parameters!.constructs).toBe(true); }), undefined)).not.toThrow(/corrupt/);
    for (const change of [
      (symbols: Stored["files"][number]["symbols"]) => { symbols[0]!.primary = false; },
      (symbols: Stored["files"][number]["symbols"]) => { symbols[1]!.primary = true; },
      (symbols: Stored["files"][number]["symbols"]) => { symbols[1]!.parameters!.constructs = 1; },
    ]) expect(() => deserializeArtifact(corrupt(change), undefined)).toThrow(/corrupt/);
  });

  it("refuses corrupted member-type access metadata on load", async () => {
    await write({ "A.java": "class A {\n  private static class T { }\n  void run() { }\n}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    type Stored = { files: { symbols: { q: string; access?: unknown }[] }[] };
    const corrupt = (change: (symbols: Stored["files"][number]["symbols"]) => void): string => {
      const data = JSON.parse(serializeArtifact(index).toString()) as Stored;
      change(data.files[0]!.symbols);
      return JSON.stringify(data);
    };
    expect(() => deserializeArtifact(corrupt((symbols) => { expect(symbols.find((symbol) => symbol.q === "A.T")!.access).toBe("private"); }), undefined)).not.toThrow(/corrupt/);
    for (const change of [
      (symbols: Stored["files"][number]["symbols"]) => { symbols.find((symbol) => symbol.q === "A.T")!.access = "public"; },
      (symbols: Stored["files"][number]["symbols"]) => { symbols.find((symbol) => symbol.q === "A.run")!.access = "private"; },
    ]) expect(() => deserializeArtifact(corrupt(change), undefined)).toThrow(/corrupt/);
  });

  it("refuses corrupted generic arity metadata on load", async () => {
    await write({ "Box.cs": "class Box<T> {\n  public void Run() { }\n}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    type Stored = { files: { symbols: { q: string; arity?: unknown }[] }[] };
    const corrupt = (change: (symbols: Stored["files"][number]["symbols"]) => void): string => {
      const data = JSON.parse(serializeArtifact(index).toString()) as Stored;
      change(data.files[0]!.symbols);
      return JSON.stringify(data);
    };
    expect(() => deserializeArtifact(corrupt((symbols) => { expect(symbols.find((symbol) => symbol.q === "Box")!.arity).toBe(1); }), undefined)).not.toThrow(/corrupt/);
    for (const change of [
      (symbols: Stored["files"][number]["symbols"]) => { symbols.find((symbol) => symbol.q === "Box")!.arity = 0; },
      (symbols: Stored["files"][number]["symbols"]) => { symbols.find((symbol) => symbol.q === "Box")!.arity = "1"; },
      (symbols: Stored["files"][number]["symbols"]) => { symbols.find((symbol) => symbol.q === "Box.Run")!.arity = 1; },
    ]) expect(() => deserializeArtifact(corrupt(change), undefined)).toThrow(/corrupt/);
  });

  it("refuses a stored construction marker on a non-call edge or with another value", async () => {
    await write(java);
    const index = await buildIndex(workspace, { cacheDir });
    const paths = [...index.files.keys()].sort();
    const text = serializeEdges(index.edges, paths).bytes.toString("utf8");
    const [header, ...rows] = text.slice(0, -1).split("\n");
    const at = rows.findIndex((row) => (JSON.parse(row) as unknown[])[12] === 1);
    expect(at).toBeGreaterThanOrEqual(0);
    const corrupt = (change: (tuple: unknown[]) => void): Buffer => {
      const copy = rows.map((row) => JSON.parse(row) as unknown[]);
      change(copy[at]!);
      return Buffer.from(`${[header, ...copy.map((tuple) => JSON.stringify(tuple))].join("\n")}\n`, "utf8");
    };
    expect(() => deserializeEdges(corrupt(() => undefined), paths, index.files)).not.toThrow();
    for (const code of [3, -1, "instance", null]) expect(() => deserializeEdges(corrupt((tuple) => { tuple[12] = code; }), paths, index.files)).toThrow(/corrupt/);
    expect(() => deserializeEdges(corrupt((tuple) => { tuple[0] = edgeKinds.indexOf("references"); tuple[10] = -1; }), paths, index.files)).toThrow(/corrupt/);
  });
});

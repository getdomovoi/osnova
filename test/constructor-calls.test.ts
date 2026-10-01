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

describe("C# object creation", () => {
  // C# binds a type name through using directives, namespaces and type parameters, which the index does not
  // follow, so a C# creation keeps the name resolution of any call and is not marked as a creation.
  it("keeps name resolution and names no constructor the compiler may not run", async () => {
    await write({
      "Mixed.cs": "namespace A {\n  public partial class C {\n    public class T { public T() {} }\n  }\n}\nnamespace B {\n  public partial class C {\n    public static void Use() { new T(); }\n  }\n}\nclass T { public T() {} }\n",
      "Generic.cs": "class T { public T() {} }\nclass Actual { public Actual() {} }\nclass C<T> where T : new() {\n  public static object Use() { return new T(); }\n}\n",
      "Arity.cs": "class U { public U() {} }\nclass UseU { public static void Run() { new U<int>(); } }\n",
      "ArityGeneric.cs": "class U<TItem> { public U() {} }\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "Mixed.cs", 8)).toMatchObject({ toSymbol: undefined, constructs: undefined });
    expect(creationAt(index, "Generic.cs", 4)).toMatchObject({ toSymbol: undefined, constructs: undefined });
    expect(creationAt(index, "Arity.cs", 2)).toMatchObject({ toSymbol: undefined, constructs: undefined });
  });
});

describe("a creation names only an instance constructor of the type it names", () => {
  it("does not take a Java method named like its class for a constructor", async () => {
    await write({ "T.java": "class T {\n  void T() {}\n  static void use() {\n    new T();\n  }\n}\n" });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "T.java", 4)).toMatchObject({ toSymbol: "T.java#T", overload: undefined });
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

  it("names the type when it declares a canonical constructor", async () => {
    await write({
      "R.java": "record R(int x) {\n  R(String text) { this(0); }\n  static void use() {\n    new R(1);\n  }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "R.java", 4)).toMatchObject({ toSymbol: "R.java#R", overload: undefined });
  });
});

describe("a creation claims a declaration only where the compiler's binding is proven", () => {
  it("keeps the chosen constructor's line when an excluded declaration shares its name", async () => {
    await write({
      "T.java": "class T {\n  T() {}\n  void T() {}\n  static void use() { new T(); }\n}\n",
    });
    const index = await buildIndex(workspace, { cacheDir });
    expect(creationAt(index, "T.java", 4)).toMatchObject({ toSymbol: "T.java#T.T", overload: { line: 2 } });
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

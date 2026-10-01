import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyChanges, buildIndex, loadIndex } from "../src/index.js";
import { deserializeEdges, serializeEdges } from "../src/index/edgeStore.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-overload-inherited-"));
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
const choiceAt = (index: Index, file: string, line: number, toName: string) => {
  const found = index.edges.filter((edge) => edge.kind === "calls" && edge.fromFile === file && edge.line === line && edge.toName === toName);
  expect(found, `${file}:${line} ${toName}`).toHaveLength(1);
  const edge = found[0]!;
  return { toSymbol: edge.toSymbol, toFile: edge.toFile, overload: edge.overload, resolution: edge.evidence?.source === "syntax" ? edge.evidence.resolution : undefined };
};

const element = [
  /*  1 */ "package p;",
  /*  2 */ "public abstract class Element {",
  /*  3 */ "  public Obj getAsObj() { return null; }",
  /*  4 */ "  public String get(int i) { return null; }",
  /*  5 */ "  public String get(String key) { return null; }",
  /*  6 */ "  public String name() { return null; }",
  /*  7 */ "  private void reset(int depth) { }",
  /*  8 */ "}",
].join("\n");

const obj = [
  /*  1 */ "package p;",
  /*  2 */ "public class Obj extends Element {",
  /*  3 */ "  public Obj getAsObj(String member) { return null; }",
  /*  4 */ "  @Override public String get(String key) { return null; }",
  /*  5 */ "  @Override public String name() { return null; }",
  /*  6 */ "  private void reset() { }",
  /*  7 */ "  void run() { reset(); }",
  /*  8 */ "}",
].join("\n");

const stray = [
  /*  1 */ "package p;",
  /*  2 */ "public class Stray extends Missing {",
  /*  3 */ "  public void put(int a) { }",
  /*  4 */ "}",
].join("\n");

const javaUse = [
  /*  1 */ "package p;",
  /*  2 */ "public class Use {",
  /*  3 */ "  void run(Obj obj, Stray stray) {",
  /*  4 */ "    obj.getAsObj();",
  /*  5 */ "    obj.getAsObj(\"m\");",
  /*  6 */ "    obj.get(\"k\");",
  /*  7 */ "    obj.name();",
  /*  8 */ "    stray.put();",
  /*  9 */ "  }",
  /* 10 */ "}",
].join("\n");

const java = { "src/Element.java": element, "src/Obj.java": obj, "src/Stray.java": stray, "src/Use.java": javaUse };

describe("Java overloads declared in a superclass", () => {
  it("moves the edge to the superclass declaration when only it accepts the argument count", async () => {
    await write(java);
    const index = await buildIndex(workspace, { cacheDir });
    const choice = choiceAt(index, "src/Use.java", 4, "getAsObj");
    expect(choice.toSymbol).toBe("src/Element.java#Element.getAsObj");
    expect(choice.toFile).toBe("src/Element.java");
    expect(choice.overload).toEqual({ line: 3, from: "src/Obj.java#Obj.getAsObj" });
    expect(choice.resolution).toMatchObject({ status: "resolved", method: "receiver-hint", receiver: { classSymbol: "src/Obj.java#Obj" } });
  });

  it("keeps the own declaration when the superclass adds no declaration that accepts the count", async () => {
    await write(java);
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "src/Use.java", 5, "getAsObj")).toMatchObject({ toSymbol: "src/Obj.java#Obj.getAsObj", overload: undefined });
  });

  it("treats an override as taking its base declaration's place, so a lone override stays chosen", async () => {
    await write(java);
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "src/Use.java", 7, "name")).toMatchObject({ toSymbol: "src/Obj.java#Obj.name", overload: undefined });
  });

  it("names no declaration when a superclass overload of the same count remains beside the override", async () => {
    await write(java);
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "src/Use.java", 6, "get")).toMatchObject({
      toSymbol: "src/Obj.java#Obj.get",
      overload: { candidates: [4], elsewhere: [{ file: "src/Element.java", line: 4 }] },
    });
  });

  it("leaves out a superclass declaration the subclass cannot call", async () => {
    await write(java);
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "src/Obj.java", 7, "reset")).toMatchObject({ toSymbol: "src/Obj.java#Obj.reset", overload: undefined });
  });

  it("changes nothing when a declared base cannot be identified", async () => {
    await write(java);
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "src/Use.java", 8, "put")).toMatchObject({ toSymbol: "src/Stray.java#Stray.put", overload: { candidates: [] } });
  });

  it("records the written override marker with the parameter range", async () => {
    await write(java);
    const index = await buildIndex(workspace, { cacheDir });
    const ranges = index.files.get("src/Obj.java")?.symbols.filter((symbol) => symbol.kind === "method").map((symbol) => [symbol.span.startLine, symbol.parameters]);
    expect(ranges).toEqual([[3, { min: 1, max: 1, types: ["String"] }], [4, { min: 1, max: 1, overrides: true, types: ["String"] }],
      [5, { min: 0, max: 0, overrides: true, types: [] }], [6, { min: 0, max: 0, access: "private", types: [] }], [7, { min: 0, max: 0, access: "package", types: [] }]]);
  });
});

const ordinalBase = [
  /*  1 */ "namespace P {",
  /*  2 */ "  class Ordinal {",
  /*  3 */ "    public virtual string Convert(int n, string s) => s;",
  /*  4 */ "    public virtual string Convert(long n, string s) => s;",
  /*  5 */ "    protected static bool TryGet(long n, out int v) { v = 0; return true; }",
  /*  6 */ "    public string Only() => \"\";",
  /*  7 */ "  }",
  /*  8 */ "}",
].join("\n");

const ordinalSuffix = [
  /*  1 */ "namespace P {",
  /*  2 */ "  class Suffix : Ordinal {",
  /*  3 */ "    public override string Convert(long n, string s) => s;",
  /*  4 */ "    static bool TryGet(ulong n, out int v) { v = 0; return true; }",
  /*  5 */ "    public string Only(int x) => \"\";",
  /*  6 */ "    void Run(ulong u) {",
  /*  7 */ "      Convert(1, \"a\");",
  /*  8 */ "      TryGet(u, out var a);",
  /*  9 */ "      Only();",
  /* 10 */ "    }",
  /* 11 */ "  }",
  /* 12 */ "}",
].join("\n");

const genMain = [
  /*  1 */ "partial class Gen {",
  /*  2 */ "  static string Make(int a) => \"\";",
  /*  3 */ "  static void Run() {",
  /*  4 */ "    Gen.Make(1, 2);",
  /*  5 */ "    Make(1);",
  /*  6 */ "  }",
  /*  7 */ "}",
].join("\n");

const genHelpers = [
  /*  1 */ "partial class Gen {",
  /*  2 */ "  static string Make(int a, int b) => \"\";",
  /*  3 */ "  static string Make(string s) => \"\";",
  /*  4 */ "}",
].join("\n");

const loudOne = [
  /*  1 */ "sealed class Loud : ITransformer {",
  /*  2 */ "  public string Transform(string input) => Transform(input, 1);",
  /*  3 */ "  public string Transform(string input, int level) => input;",
  /*  4 */ "}",
].join("\n");

const loudTwo = [
  /*  1 */ "sealed class Loud : ITransformer {",
  /*  2 */ "  public string Transform(string input, int level) => input;",
  /*  3 */ "}",
].join("\n");

const generatorMain = [
  /*  1 */ "public partial class Generator : IIncrementalGenerator {",
  /*  2 */ "  static string Emit(int a) => \"\";",
  /*  3 */ "  static void Run() {",
  /*  4 */ "    Generator.Emit(1);",
  /*  5 */ "    Generator.Emit(1, 2);",
  /*  6 */ "  }",
  /*  7 */ "}",
].join("\n");

const generatorHelpers = [
  /*  1 */ "public partial class Generator {",
  /*  2 */ "  static string Emit(string s) => \"\";",
  /*  3 */ "  static string Emit(int a, int b) => \"\";",
  /*  4 */ "}",
].join("\n");

const csharp = { "src/Generator.cs": generatorMain, "src/Generator.Helpers.cs": generatorHelpers, "src/Ordinal.cs": ordinalBase, "src/Suffix.cs": ordinalSuffix, "src/Gen.cs": genMain, "src/Gen.Helpers.cs": genHelpers, "docs/a/Loud.cs": loudOne, "docs/b/Loud.cs": loudTwo };

describe("C# overloads declared in a base class or another partial declaration", () => {
  it("names no declaration when a base overload the override does not replace accepts the count", async () => {
    await write(csharp);
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "src/Suffix.cs", 7, "Convert")).toMatchObject({
      toSymbol: "src/Suffix.cs#Suffix.Convert",
      overload: { candidates: [3], elsewhere: [{ file: "src/Ordinal.cs", line: 3 }, { file: "src/Ordinal.cs", line: 4 }] },
    });
    expect(choiceAt(index, "src/Suffix.cs", 8, "TryGet")).toMatchObject({
      toSymbol: "src/Suffix.cs#Suffix.TryGet",
      overload: { candidates: [4], elsewhere: [{ file: "src/Ordinal.cs", line: 5 }] },
    });
  });

  it("moves a plain call to the base declaration that alone accepts the count", async () => {
    await write(csharp);
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "src/Suffix.cs", 9, "Only")).toMatchObject({
      toSymbol: "src/Ordinal.cs#Ordinal.Only", toFile: "src/Ordinal.cs", overload: { line: 6, from: "src/Suffix.cs#Suffix.Only" },
      resolution: { status: "resolved", method: "same-file-name" },
    });
  });

  it("counts the declarations of every partial declaration of the type", async () => {
    await write(csharp);
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "src/Gen.cs", 4, "Make")).toMatchObject({
      toSymbol: "src/Gen.Helpers.cs#Gen.Make", toFile: "src/Gen.Helpers.cs", overload: { line: 2, from: "src/Gen.cs#Gen.Make" },
    });
    expect(choiceAt(index, "src/Gen.cs", 5, "Make")).toMatchObject({
      toSymbol: "src/Gen.cs#Gen.Make", overload: { candidates: [2], elsewhere: [{ file: "src/Gen.Helpers.cs", line: 3 }] },
    });
  });

  it("does not merge same-named types that are not written partial", async () => {
    await write(csharp);
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "docs/a/Loud.cs", 2, "Transform")).toMatchObject({ toSymbol: "docs/a/Loud.cs#Loud.Transform", overload: { line: 3 } });
  });

  it("refuses past an unidentified base only when two declarations already accept the count", async () => {
    await write(csharp);
    const index = await buildIndex(workspace, { cacheDir });
    expect(choiceAt(index, "src/Generator.cs", 4, "Emit")).toMatchObject({
      toSymbol: "src/Generator.cs#Generator.Emit", overload: { candidates: [2], elsewhere: [{ file: "src/Generator.Helpers.cs", line: 2 }] },
    });
    expect(choiceAt(index, "src/Generator.cs", 5, "Emit")).toMatchObject({ toSymbol: "src/Generator.cs#Generator.Emit", overload: { candidates: [] } });
  });

  it("records the override modifier with the parameter range", async () => {
    await write(csharp);
    const index = await buildIndex(workspace, { cacheDir });
    const ranges = index.files.get("src/Suffix.cs")?.symbols.filter((symbol) => symbol.kind === "method").map((symbol) => [symbol.span.startLine, symbol.parameters]);
    expect(ranges).toEqual([[3, { min: 2, max: 2, overrides: true }], [4, { min: 2, max: 2, access: "private" }], [5, { min: 1, max: 1 }], [6, { min: 1, max: 1, access: "private" }]]);
    expect(index.files.get("src/Gen.cs")?.symbols.find((symbol) => symbol.kind === "class")?.partial).toBe("`0");
    expect(index.files.get("src/Suffix.cs")?.symbols.find((symbol) => symbol.kind === "class")?.partial).toBeUndefined();
  });
});

describe("inherited overload choices across the cache and incremental updates", () => {
  it("survives a save and load", async () => {
    await write({ ...java, ...csharp });
    const built = await buildIndex(workspace, { cacheDir });
    const loaded = await loadIndex(workspace, { cacheDir });
    expect(loaded?.edges).toEqual(built.edges);
  });

  it("re-chooses when a superclass changes, equal to a full rebuild", async () => {
    await write(java);
    const before = await buildIndex(workspace, { cacheDir });
    await write({ "src/Element.java": element.replace("  public Obj getAsObj() { return null; }", "  public Obj getAsObj(int depth, int limit) { return null; }") });
    const updated = await applyChanges(before, workspace, ["src/Element.java"]);
    const fresh = await buildIndex(workspace, { cacheDir: path.join(temporary, "fresh-cache") });
    expect(updated.edges).toEqual(fresh.edges);
    expect(choiceAt(updated, "src/Use.java", 4, "getAsObj")).toMatchObject({ toSymbol: "src/Obj.java#Obj.getAsObj", overload: { candidates: [] } });
  });

  it("re-chooses when a partial declaration changes, equal to a full rebuild", async () => {
    await write(csharp);
    const before = await buildIndex(workspace, { cacheDir });
    await write({ "src/Gen.Helpers.cs": genHelpers.replace("  static string Make(string s) => \"\";", "  static string Make(string s, int t, int u) => \"\";") });
    const updated = await applyChanges(before, workspace, ["src/Gen.Helpers.cs"]);
    const fresh = await buildIndex(workspace, { cacheDir: path.join(temporary, "fresh-cache") });
    expect(updated.edges).toEqual(fresh.edges);
    expect(choiceAt(updated, "src/Gen.cs", 5, "Make")).toMatchObject({ toSymbol: "src/Gen.cs#Gen.Make", overload: undefined });
  });

  it("keeps a moved edge when only a base method body changes, equal to a full rebuild", async () => {
    await write(java);
    const before = await buildIndex(workspace, { cacheDir });
    await write({ "src/Element.java": element.replace("public Obj getAsObj() { return null; }", "public Obj getAsObj() { return (Obj) this; }") });
    const updated = await applyChanges(before, workspace, ["src/Element.java"]);
    const fresh = await buildIndex(workspace, { cacheDir: path.join(temporary, "fresh-cache") });
    expect(updated.edges).toEqual(fresh.edges);
    expect(choiceAt(updated, "src/Use.java", 4, "getAsObj").toSymbol).toBe("src/Element.java#Element.getAsObj");
  });
});

describe("stored inherited overload metadata", () => {
  it("refuses a corrupted provenance or elsewhere list on load", async () => {
    await write({ ...java, ...csharp });
    const index = await buildIndex(workspace, { cacheDir });
    const paths = [...index.files.keys()].sort();
    const lines = serializeEdges(index.edges, paths).bytes.toString("utf8").split("\n");
    const header = JSON.parse(lines[0]!) as { overloads: unknown[] };
    for (const corrupt of [
      { line: 3, from: "" }, { line: 3, from: 7 },
      { candidates: [], elsewhere: [] }, { candidates: [], elsewhere: [{ file: "src/Missing.java", line: 2 }] },
      { candidates: [], elsewhere: [{ file: "src/Obj.java", line: 4 }, { file: "src/Element.java", line: 4 }] },
    ]) {
      const tampered = [JSON.stringify({ ...header, overloads: [corrupt, ...header.overloads.slice(1)] }), ...lines.slice(1)].join("\n");
      expect(() => deserializeEdges(Buffer.from(tampered), paths, index.files), JSON.stringify(corrupt)).toThrow(/corrupt overload metadata/);
    }
  });
});

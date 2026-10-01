import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyChanges, buildIndex, loadIndex, serializeArtifact } from "../src/index.js";
import { deserializeEdges, edgeKinds, serializeEdges } from "../src/index/edgeStore.js";

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
    expect(creationAt(index, "Q/Use.cs", 5)).toEqual({ toName: "Box", toSymbol: "P/Box.cs#Box.Box", constructs: "instance", arguments: 1, overload: { line: 3 }, status: "resolved" });
    expect(creationAt(index, "Q/Use.cs", 6)).toMatchObject({ toName: "P.Box", toSymbol: "P/Box.cs#Box.Box", constructs: "instance", arguments: 2, overload: { line: 4 } });
    expect(creationAt(index, "Q/Use.cs", 7)).toMatchObject({ toName: "Plain", toSymbol: "P/Box.cs#Plain", constructs: "instance", arguments: 0, overload: undefined });
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

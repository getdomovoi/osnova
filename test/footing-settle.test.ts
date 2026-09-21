import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import type { FileCard, OsnovaEdge, OsnovaSymbol } from "../src/types.js";
import { impact } from "../src/query/impact.js";
import { taskContext } from "../src/query/task-context.js";
import { formatImpact, formatTaskContext } from "../src/query/format.js";

function card(path: string, names: string[], text = `${names.map((name) => `function ${name}() { return 1; }`).join("\n")}\n`): FileCard {
  const symbols: OsnovaSymbol[] = names.map((name, i) => ({ name, qualifiedName: `${path}#${name}`, file: path,
    kind: "function", signature: `function ${name}()`, lineCount: 1,
    span: { startLine: i + 1, endLine: i + 1, startCol: 0, endCol: (text.split("\n")[i] ?? "").length } }));
  return { path, symbols, text, hash: createHash("sha256").update(text).digest("hex"),
    language: names.length ? "typescript" : "fallback", size: text.length, lineCount: text.split("\n").length };
}

function edge(from: string, to: string): OsnovaEdge {
  return { kind: "calls", fromFile: from.split("#")[0]!, fromSymbol: from, toName: to.split("#")[1]!,
    toSymbol: to, toFile: to.split("#")[0]!, line: 1,
    evidence: { source: "syntax", resolution: { status: "resolved", method: "import-binding" } } };
}

function index(files: FileCard[], edges: OsnovaEdge[] = []): OsnovaIndexImpl {
  return new OsnovaIndexImpl("/fixture", new Map(files.map((file) => [file.path, file])), edges);
}

describe("settle on a single index", () => {
  const current = index([card("a.ts", ["target"]), card("b.ts", ["middle"]), card("c.test.ts", ["check"])],
    [edge("b.ts#middle", "a.ts#target"), edge("c.test.ts#check", "b.ts#middle")]);
  const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-function target() { return 1; }\n+function target() { return 2; }\n";

  it("walks dependents once when base and current are the same index", () => {
    const result = impact(current, current, { diff });
    expect(result.changes.map((change) => [change.kind, change.basis])).toEqual([["changed", "diff-range"]]);
    expect(result.dependents.map((hit) => [hit.snapshot, hit.symbol?.name, hit.depth])).toEqual([
      ["current", "middle", 1], ["current", "check", 2],
    ]);
    expect(result.uncertainty.unresolvedEdges).toBe(0);
    expect(result.uncertainty.notes).toContain("base-snapshot-is-current-index");
  });

  it("uses current-side coordinates only when base and current are the same index", () => {
    const one = index([card("a.ts", ["keep"])]);
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,1 @@\n-function gone() { return 1; }\n function keep() { return 1; }\n";
    const result = impact(one, one, { diff });
    expect(result.changes).toEqual([]);
    const touching = "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-function keep() { return 0; }\n+function keep() { return 1; }\n";
    expect(impact(one, one, { diff: touching }).changes.map((change) => change.after?.symbol.name)).toEqual(["keep"]);
  });

  it("formats settle output with counts before detail", () => {
    const text = formatImpact(impact(current, current, { diff, maxDepth: 1 }));
    expect(text.split("\n")[0]).toBe("osnova settle: 1 symbol changes; 1 dependents; 1 frontier items omitted");
    expect(text).toContain("changed: a.ts#target -> a.ts#target");
    expect(text).toContain("current d1 b.ts#middle");
    expect(text).toContain("uncertainty: 0 unresolved edges not listed");
  });

  it("prints a 16-hex receipt prefix per dependent while the API keeps the full hash", () => {
    const result = impact(current, current, { diff, maxDepth: 1 });
    const hash = result.dependents[0]!.receipt.hash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const line = formatImpact(result).split("\n").find((item) => item.startsWith("current d1 b.ts#middle"));
    expect(line).toBe(`current d1 b.ts#middle [source ${hash.slice(0, 16)}]`);
  });

  it("states every settle limit once in short prose", () => {
    const short = "--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n-function target() { return 1; }\n+function target() { return 2; }\n";
    const result = impact(current, current, { diff: short, maxDepth: 1 });
    expect(result.uncertainty.notes).toEqual(["indexed-graph-only", "base-snapshot-is-current-index", "deleted-symbols-not-visible",
      "receipts-identify-indexed-content-not-disk-freshness", "rename-identity-is-not-proven", "one-shortest-path-per-dependent",
      "provided-diff-ranges-not-verified-against-source", "diff-short-by-2-context-lines-treated-as-unchanged"]);
    const line = formatImpact(result).split("\n").at(-1)!;
    expect(line).toBe("uncertainty: 0 unresolved edges not listed; a missing dependent is not proof of absence; base = current index, deletions invisible; " +
      "receipts = indexed content, not disk or runtime; renames unproven; one shortest path each; diff ranges unverified; diff 2 context lines short, treated unchanged");
    expect(line.length).toBeLessThan(300);
  });
});

describe("settle line attribution", () => {
  const boxText = "class Box {\n  a() {\n    return 1;\n  }\n  b() {\n    return 2;\n  }\n}\n";
  const boxCard = (methods: readonly [string, string]): FileCard => {
    const text = boxText.replace("  a()", `  ${methods[0]}()`).replace("  b()", `  ${methods[1]}()`);
    const method = (name: string, startLine: number): OsnovaSymbol => ({ name, qualifiedName: `k.ts#Box.${name}`, file: "k.ts", kind: "method",
      signature: `${name}()`, lineCount: 3, span: { startLine, endLine: startLine + 2, startCol: 2, endCol: 3 } });
    const symbols: OsnovaSymbol[] = [{ name: "Box", qualifiedName: "k.ts#Box", file: "k.ts", kind: "class", signature: "class Box", lineCount: 8,
      span: { startLine: 1, endLine: 8, startCol: 0, endCol: 1 } }, method(methods[0], 2), method(methods[1], 5)];
    return { path: "k.ts", symbols, text, hash: createHash("sha256").update(text).digest("hex"), language: "typescript", size: text.length, lineCount: 9 };
  };
  const users = card("u.ts", ["useA", "useB", "useBox"]);
  const edges = (first: string): OsnovaEdge[] => [edge("u.ts#useA", `k.ts#Box.${first}`), edge("u.ts#useB", "k.ts#Box.b"), edge("u.ts#useBox", "k.ts#Box")];
  const current = index([boxCard(["a", "b"]), users], edges("a"));

  it("attributes a body edit to the innermost symbol even when hunk context spans its neighbours", () => {
    const diff = "--- a/k.ts\n+++ b/k.ts\n@@ -3,6 +3,6 @@\n     return 1;\n   }\n   b() {\n-    return 2;\n+    return 3;\n   }\n }\n";
    const result = impact(current, current, { diff, maxDepth: 1 });
    expect(result.changes.map((change) => `${change.kind}: ${change.after?.symbol.qualifiedName}`)).toEqual(["changed: k.ts#Box.b"]);
    expect(result.dependents.map((hit) => hit.symbol?.qualifiedName)).toEqual(["u.ts#useB"]);
    expect(result.omitted.dependentFrontier).toBe(0);
  });

  it("attributes a class-level edit to the class, not its methods", () => {
    const diff = "--- a/k.ts\n+++ b/k.ts\n@@ -1,3 +1,3 @@\n-class Box {\n+class Box extends Base {\n   a() {\n     return 1;\n";
    const result = impact(current, current, { diff, maxDepth: 1 });
    expect(result.changes.map((change) => change.after?.symbol.qualifiedName)).toEqual(["k.ts#Box"]);
    expect(result.dependents.map((hit) => hit.symbol?.qualifiedName)).toEqual(["u.ts#useBox"]);
  });

  it("reports a method rename across indexes without attributing the change to the class", () => {
    const base = current;
    const next = index([boxCard(["c", "b"]), users], edges("c"));
    const diff = "--- a/k.ts\n+++ b/k.ts\n@@ -1,5 +1,5 @@\n class Box {\n-  a() {\n+  c() {\n     return 1;\n   }\n   b() {\n";
    const result = impact(base, next, { diff, maxDepth: 1 });
    expect(result.changes.map((change) => `${change.kind}: ${change.before?.symbol.qualifiedName ?? "<new>"} -> ${change.after?.symbol.qualifiedName ?? "<deleted>"}`))
      .toEqual(["renamed: k.ts#Box.a -> k.ts#Box.c"]);
    expect(result.dependents.map((hit) => [hit.snapshot, hit.symbol?.qualifiedName])).toEqual([["base", "u.ts#useA"], ["current", "u.ts#useA"]]);
  });

  it("seeds a diffed two-index comparison from symbol changes and counts importers of the changed file instead of listing them", () => {
    const imports = (from: string): OsnovaEdge => ({ kind: "imports", fromFile: from, fromSymbol: from, toName: "./k", toFile: "k.ts", line: 1,
      evidence: { source: "syntax", resolution: { status: "resolved", method: "import-path" } } });
    const other = card("w.ts", ["useW"]);
    const base = index([boxCard(["a", "b"]), users, other], [...edges("a"), imports("u.ts"), imports("w.ts")]);
    const next = index([boxCard(["c", "b"]), users, other], [...edges("c"), imports("u.ts"), imports("w.ts")]);
    const diff = "--- a/k.ts\n+++ b/k.ts\n@@ -1,5 +1,5 @@\n class Box {\n-  a() {\n+  c() {\n     return 1;\n   }\n   b() {\n";
    const result = impact(base, next, { diff, maxDepth: 1 });
    expect(result.changes.map((change) => `${change.kind}: ${change.before?.symbol.qualifiedName} -> ${change.after?.symbol.qualifiedName}`)).toEqual(["renamed: k.ts#Box.a -> k.ts#Box.c"]);
    expect(result.dependents.map((hit) => [hit.snapshot, hit.symbol?.qualifiedName ?? hit.file])).toEqual([["base", "u.ts#useA"], ["current", "u.ts#useA"]]);
    expect(result.files.map((file) => file.after?.file)).toEqual(["k.ts"]);
    expect(result.omitted.fileImporters).toBe(2);
    const text = formatImpact(result);
    expect(text.split("\n")[0]).toBe("osnova settle: 1 symbol changes; 2 dependents; 0 frontier items omitted");
    expect(text).toContain("files changed: 1; importers of changed files: 2 (not listed; module-level edits attribute to no symbol)");
    expect(text).not.toContain("w.ts");
  });

  it("still lists the importers of a changed file when no symbol-level change was found", () => {
    const imports = (from: string): OsnovaEdge => ({ kind: "imports", fromFile: from, fromSymbol: from, toName: "./k", toFile: "k.ts", line: 1,
      evidence: { source: "syntax", resolution: { status: "resolved", method: "import-path" } } });
    const other = card("w.ts", ["useW"]);
    const base = index([boxCard(["a", "b"]), users, other], [...edges("a"), imports("u.ts"), imports("w.ts")]);
    const grown = { ...boxCard(["a", "b"]), text: `${boxCard(["a", "b"]).text}const X = 1;\n`, lineCount: 10 };
    const next = index([{ ...grown, hash: createHash("sha256").update(grown.text).digest("hex") }, users, other], [...edges("a"), imports("u.ts"), imports("w.ts")]);
    const diff = "--- a/k.ts\n+++ b/k.ts\n@@ -8,1 +8,2 @@\n }\n+const X = 1;\n";
    const result = impact(base, next, { diff, maxDepth: 1 });
    expect(result.changes).toEqual([]);
    expect(result.dependents.map((hit) => [hit.snapshot, hit.symbol?.qualifiedName ?? hit.file])).toEqual([["base", "u.ts"], ["base", "w.ts"], ["current", "u.ts"], ["current", "w.ts"]]);
    expect(result.omitted.fileImporters).toBe(0);
    expect(formatImpact(result)).toContain("files changed: 1; importers of changed files: 0 (not listed; module-level edits attribute to no symbol)");
  });

  it("keeps the file seed when a symbol rename and a module-level edit share one file", () => {
    const imports = (from: string): OsnovaEdge => ({ kind: "imports", fromFile: from, fromSymbol: from, toName: "./k", toFile: "k.ts", line: 1,
      evidence: { source: "syntax", resolution: { status: "resolved", method: "import-path" } } });
    const other = card("w.ts", ["useW"]);
    const base = index([boxCard(["a", "b"]), users, other], [...edges("a"), imports("u.ts"), imports("w.ts")]);
    const grown = { ...boxCard(["c", "b"]), text: `${boxCard(["c", "b"]).text}const X = 1;\n`, lineCount: 10 };
    const next = index([{ ...grown, hash: createHash("sha256").update(grown.text).digest("hex") }, users, other], [...edges("c"), imports("u.ts"), imports("w.ts")]);
    const diff = "--- a/k.ts\n+++ b/k.ts\n@@ -1,5 +1,5 @@\n class Box {\n-  a() {\n+  c() {\n     return 1;\n   }\n   b() {\n@@ -8,1 +8,2 @@\n }\n+const X = 1;\n";
    const result = impact(base, next, { diff, maxDepth: 1 });
    expect(result.changes.map((change) => `${change.kind}: ${change.before?.symbol.qualifiedName ?? "<new>"} -> ${change.after?.symbol.qualifiedName}`)).toEqual(["renamed: k.ts#Box.a -> k.ts#Box.c"]);
    expect(result.dependents.map((hit) => [hit.snapshot, hit.symbol?.qualifiedName ?? hit.file])).toEqual([["base", "u.ts"], ["base", "w.ts"], ["base", "u.ts#useA"], ["current", "u.ts"], ["current", "w.ts"], ["current", "u.ts#useA"]]);
    expect(result.omitted.fileImporters).toBe(0);
  });
});

describe("footing seeds", () => {
  it("skips prose documents and keeps looking for definitions", () => {
    const prose = Array.from({ length: 6 }, (_, i) => ({ ...card(`docs/guide-${i}.md`, [], `# How the resolver walks a package on disk\n\nThe resolver walks the package on disk. ${i}\n`), language: "fallback" as const }));
    const code = card("src/lookup.ts", ["findModule", "walkPackage", "readEntry"]);
    const one = index([...prose, code], [edge("src/lookup.ts#findModule", "src/lookup.ts#walkPackage"), edge("src/lookup.ts#walkPackage", "src/lookup.ts#readEntry")]);
    const question = "how the resolver walks a package on disk";
    const plain = one.files.get("docs/guide-0.md");
    expect(plain?.symbols).toHaveLength(0);
    const result = taskContext(one, { task: "understand", question, limit: 1 });
    expect(result.sources.map((source) => source.file)).toEqual(["src/lookup.ts"]);
    expect(result.definitions.map((definition) => definition.symbol.name)).toContain("walkPackage");
    expect(result.omitted.retrievalHits).toBeGreaterThan(0);
  });
});

describe("footing seed filter", () => {
  const typed = (path: string, name: string, kind: OsnovaSymbol["kind"], text: string): FileCard => ({
    ...card(path, []), language: "typescript", text, hash: createHash("sha256").update(text).digest("hex"), size: text.length, lineCount: text.split("\n").length,
    symbols: [{ name, qualifiedName: `${path}#${name}`, file: path, kind, signature: text.split("\n")[0]!, lineCount: text.split("\n").length - 1,
      span: { startLine: 1, endLine: text.split("\n").length - 1, startCol: 0, endCol: 0 } }],
  });
  const fn = typed("src/lock.ts", "lock", "function", "export function lock(dir: string) {\n  return dir;\n}\n");
  const constant = typed("src/paths.ts", "lock", "constant", "const lock = \"lock\";\n");
  const alias = typed("src/kinds.ts", "lock", "type", "type lock = string;\n");
  const inTest = typed("test/lock.test.ts", "lock", "function", "function lock() {\n  return 1;\n}\n");
  it("seeds real definitions before 1-line constants, type aliases and test-file symbols", () => {
    const result = taskContext(index([constant, alias, inTest, fn]), { task: "understand", question: "lock", limit: 1 });
    expect(result.definitions.map((definition) => definition.symbol.qualifiedName)).toEqual(["src/lock.ts#lock"]);
    expect(result.omitted.retrievalHits).toBe(5);
  });
  it("falls back to filtered hits when nothing else matches", () => {
    const result = taskContext(index([constant, alias, inTest]), { task: "understand", question: "lock", limit: 3 });
    expect(result.definitions.map((definition) => definition.symbol.qualifiedName).sort()).toEqual(["src/kinds.ts#lock", "src/paths.ts#lock", "test/lock.test.ts#lock"]);
    expect(result.omitted.retrievalHits).toBe(1);
  });
  it("restricts seeds to the requested kinds", () => {
    const result = taskContext(index([constant, alias, inTest, fn]), { task: "understand", question: "lock", limit: 4, kinds: ["constant"] });
    expect(result.definitions.map((definition) => definition.symbol.qualifiedName)).toEqual(["src/paths.ts#lock"]);
    expect(result.omitted.retrievalHits).toBe(5);
    expect(() => taskContext(index([fn]), { task: "understand", question: "lock", kinds: [] })).toThrow("kinds must be a non-empty array");
  });
});

describe("footing formatting", () => {
  const current = index([card("a.ts", ["target"]), card("b.ts", ["middle"]), card("c.test.ts", ["check"])],
    [edge("b.ts#middle", "a.ts#target"), edge("c.test.ts#check", "b.ts#middle")]);

  it("lists definitions with excerpts, relationships, tests and omissions", () => {
    const result = taskContext(current, { task: "change", question: "", symbols: ["a.ts#target"] });
    const text = formatTaskContext(result);
    const lines = text.split("\n");
    expect(lines[0]).toBe("osnova footing: change, scope ., 3 definitions, 2 relationships, 1 candidate tests");
    expect(text).toContain("- a.ts#target function lines 1-1\n  reach: d1 callers 1 in 1 files (1 dirs); unresolved same-name 0; tests 0\n  function target() { return 1; }");
    expect(text).toContain("- b.ts#middle -> a.ts#target calls line 1");
    expect(text).toContain("candidate tests:\n- c.test.ts via c.test.ts#check");
    expect(text).toContain("omitted: 0 definitions, 0 relationships, 0 candidate tests, 0 lower-ranked candidates, 0 uncertain edges, 0 out-of-scope edges, 0 depth frontier, 0 unknown symbols");
    expect(text).toContain("limitations: indexed-structural-evidence-only");
  });

  it("stores clipped excerpts when excerptLines is set so the budget matches printed text", () => {
    const body = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const text = `function big() {\n${body}\n}\nfunction small() { return big(); }\n`;
    const big: OsnovaSymbol = { name: "big", qualifiedName: "big.ts#big", kind: "function", file: "big.ts",
      span: { startLine: 1, startCol: 0, endLine: 202, endCol: 1 }, signature: "function big()", lineCount: 202 };
    const small: OsnovaSymbol = { name: "small", qualifiedName: "big.ts#small", kind: "function", file: "big.ts",
      span: { startLine: 203, startCol: 0, endLine: 203, endCol: 34 }, signature: "function small()", lineCount: 1 };
    const file: FileCard = { ...card("big.ts", [], text), language: "typescript", symbols: [big, small] };
    const one = index([file], [edge("big.ts#small", "big.ts#big")]);
    const full = taskContext(one, { task: "change", question: "", symbols: ["big.ts#big"], maxCodeUnits: 3_072 });
    expect(full.definitions.map((definition) => definition.symbol.name)).not.toContain("big");
    expect(full.omitted.definitions).toBe(1);
    const clipped = taskContext(one, { task: "change", question: "", symbols: ["big.ts#big"], maxCodeUnits: 3_072, excerptLines: 8 });
    expect(clipped.definitions[0]?.excerpt).toBe(`${text.split("\n").slice(0, 8).join("\n")}\n[+194 more lines]`);
    expect(clipped.definitions.map((definition) => definition.symbol.name)).toEqual(["big", "small"]);
    expect(clipped.relationships).toHaveLength(1);
    expect(clipped.omitted).toMatchObject({ definitions: 0, relationships: 0 });
    expect(formatTaskContext(clipped)).toContain("  const v6 = 6;\n  [+194 more lines]\n- big.ts#small");
  });

  it("keeps relationships ahead of related definitions when the budget is tight", () => {
    const names = Array.from({ length: 12 }, (_, i) => `fn${i}`);
    const one = index([card("many.ts", names)], names.slice(1).map((name) => edge(`many.ts#${name}`, "many.ts#fn0")));
    const tight = taskContext(one, { task: "change", question: "", symbols: ["many.ts#fn0"], maxCodeUnits: 1_500,
      measure: (partial) => formatTaskContext(partial).length });
    expect(tight.definitions[0]?.symbol.name).toBe("fn0");
    expect(tight.relationships.length).toBeGreaterThan(0);
    expect(tight.definitions.length).toBeLessThan(1 + tight.relationships.length);
    expect(tight.omitted.relationships + tight.relationships.length).toBe(11);
    expect(tight.omitted.definitions + tight.definitions.length).toBe(12);
  });

  it("tolerates missing trailing context lines and says so", () => {
    const one = index([card("a.ts", ["keep", "other"])]);
    const short = "--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n-function keep() { return 0; }\n+function keep() { return 1; }\n@@ -2,3 +2,3 @@\n-function other() { return 0; }\n+function other() { return 1; }\n";
    const result = impact(one, one, { diff: short, maxDepth: 1 });
    expect(result.changes.map((change) => change.after?.symbol.name)).toEqual(["keep", "other"]);
    expect(result.uncertainty.notes).toContain("diff-short-by-4-context-lines-treated-as-unchanged");
  });

  it("still rejects a hunk that is short on one side only", () => {
    const one = index([card("a.ts", ["keep"])]);
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1,7 +1,8 @@\n-function keep() { return 0; }\n+function keep() { return 1; }\n";
    expect(() => impact(one, one, { diff })).toThrow(/incomplete unified diff hunk starting at line 3: the header promised 6 more old and 7 more new lines/);
  });

  it("reports the short hunk line when a diff is summarized", () => {
    const one = index([card("a.ts", ["keep"])]);
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1,7 +1,8 @@\n-function keep() { return 0; }\n+function keep() { return 1; }\nnonsense\n";
    expect(() => impact(one, one, { diff })).toThrow(/hunk line 6: the hunk header promised 6 more old and 7 more new lines/);
  });

  it("fits by the caller's measure instead of JSON size", () => {
    const names = Array.from({ length: 12 }, (_, i) => `fn${i}`);
    const one = index([card("many.ts", names)], names.slice(1).map((name) => edge(`many.ts#${name}`, "many.ts#fn0")));
    const byJson = taskContext(one, { task: "change", question: "", symbols: ["many.ts#fn0"], maxCodeUnits: 2_600 });
    const byText = taskContext(one, { task: "change", question: "", symbols: ["many.ts#fn0"], maxCodeUnits: 2_600,
      measure: (partial) => formatTaskContext(partial).length });
    expect(byJson.relationships.length).toBeLessThan(byText.relationships.length);
    expect(byText.relationships).toHaveLength(11);
    expect(byText.omitted.relationships).toBe(0);
    expect(formatTaskContext(byText).length).toBeLessThanOrEqual(2_600);
  });

  it("prints excerpts exactly as taskContext produced them", () => {
    const body = Array.from({ length: 12 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const text = `function big() {\n${body}\n}\n`;
    const symbol: OsnovaSymbol = { name: "big", qualifiedName: "big.ts#big", kind: "function", file: "big.ts",
      span: { startLine: 1, startCol: 0, endLine: 14, endCol: 1 }, signature: "function big()", lineCount: 14 };
    const file: FileCard = { ...card("big.ts", [], text), language: "typescript", symbols: [symbol] };
    const clipped = formatTaskContext(taskContext(index([file]), { task: "understand", question: "", symbols: ["big.ts#big"], excerptLines: 8 }));
    expect(clipped).toContain("  const v6 = 6;\n  [+6 more lines]");
    expect(clipped).not.toContain("const v7");
    const whole = formatTaskContext(taskContext(index([file]), { task: "understand", question: "", symbols: ["big.ts#big"], excerptLines: 8, inlineShortDefinitions: 40 }));
    expect(whole).toContain("  const v11 = 11;\n  }");
    expect(whole).not.toContain("more lines]");
    const caller: OsnovaSymbol = { name: "tiny", qualifiedName: "tiny.ts#tiny", kind: "function", file: "tiny.ts",
      span: { startLine: 1, startCol: 0, endLine: 1, endCol: 30 }, signature: "function tiny()", lineCount: 1 };
    const callerFile: FileCard = { ...card("tiny.ts", [], "function tiny() { return big(); }\n"), language: "typescript", symbols: [caller] };
    const walked = formatTaskContext(taskContext(index([file, callerFile], [edge("tiny.ts#tiny", "big.ts#big")]), { task: "understand", question: "", symbols: ["tiny.ts#tiny"], excerptLines: 8, inlineShortDefinitions: 40 }));
    expect(walked).toContain("- tiny.ts#tiny function lines 1-1\n  reach: d1 callers 0; unresolved same-name 0; tests 0\n  function tiny() { return big(); }");
    expect(walked).toContain("  const v6 = 6;\n  [+6 more lines]");
  });
});

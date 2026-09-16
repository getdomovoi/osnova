import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import { getParser } from "../src/grammar/loader.js";
import { adapterFor } from "../src/extract/adapters.js";
import { resolveEdges } from "../src/index/resolve.js";
import type { RawEdgeItem } from "../src/index/indexImpl.js";
import type { FileCard, OsnovaEdge, OsnovaSymbol } from "../src/types.js";
import { impact, indexReceipt } from "../src/query/impact.js";
import { detectScopes, scopedAsk } from "../src/query/scoped.js";
import { taskContext } from "../src/query/task-context.js";

function card(path: string, names: string[], text = names.map((name) => `function ${name}() { return 1; }`).join("\n")): FileCard {
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

describe("diff impact evidence", () => {
  it("retains deleted base definitions and multi-file transitive dependents", () => {
    const base = index([card("a.ts", ["old"]), card("b.ts", ["middle"]), card("c.test.ts", ["check"])],
      [edge("b.ts#middle", "a.ts#old"), edge("c.test.ts#check", "b.ts#middle")]);
    const current = index([card("b.ts", ["middle"]), card("c.test.ts", ["check"])]);
    const result = impact(base, current);
    expect(result.changes[0]?.kind).toBe("deleted");
    expect(result.changes[0]?.before?.receipt.hash).toBe(base.files.get("a.ts")?.hash);
    expect(result.changes[0]?.before?.receipt.generation).toBe(result.base.generation);
    expect(result.dependents.map((hit) => [hit.snapshot, hit.symbol?.name, hit.depth])).toEqual([
      ["base", "middle", 1], ["base", "check", 2],
    ]);
    expect(result.dependents[1]?.path.map((item) => item.edge.fromFile)).toEqual(["b.ts", "c.test.ts"]);
  });

  it("recognizes unique content file renames while retaining base callers", () => {
    const base = index([card("old.ts", ["work"]), card("caller.ts", ["run"])], [edge("caller.ts#run", "old.ts#work")]);
    const current = index([card("new.ts", ["work"]), card("caller.ts", ["run"])]);
    const result = impact(base, current);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ kind: "renamed", basis: "identical-file-hash",
      before: { symbol: { file: "old.ts" } }, after: { symbol: { file: "new.ts" } } });
    expect(result.dependents[0]?.snapshot).toBe("base");
  });

  it("maps only changed diff lines, not context, and flags rename inference", () => {
    const base = index([card("a.ts", ["old", "stable"])]);
    const current = index([card("a.ts", ["newName", "stable"])]);
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-function old() { return 1; }\n+function newName() { return 1; }\n function stable() { return 1; }\n";
    const result = impact(base, current, { diff });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.kind).toBe("renamed");
    expect(result.changes[0]?.uncertainty).toContain("symbol-identity-inferred");
  });

  it("accepts blank context lines whose leading space was stripped", () => {
    const base = index([card("a.ts", ["old", "stable"])]);
    const current = index([card("a.ts", ["newName", "stable"])]);
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n-function old() { return 1; }\n+function newName() { return 1; }\n\n function stable() { return 1; }\n";
    const result = impact(base, current, { diff });
    expect(result.changes.map((change) => change.kind)).toEqual(["renamed"]);
  });

  it("compares spans without marking unchanged siblings", () => {
    const base = index([card("a.ts", ["work", "stable"])]);
    const current = index([card("a.ts", ["work", "stable"], "function work() { return 2; }\nfunction stable() { return 1; }")]);
    expect(impact(base, current).changes.map((change) => change.after?.symbol.name)).toEqual(["work"]);
  });

  it("reports depth omissions, unresolved evidence and non-symbol file changes", () => {
    const base = index([card("a.ts", ["work"]), card("b.ts", ["run"]), card("c.ts", ["top"]), card("data.json", [], "{}")],
      [edge("b.ts#run", "a.ts#work"), edge("c.ts#top", "b.ts#run"),
        { kind: "calls", fromFile: "b.ts", fromSymbol: "b.ts#run", toName: "unknown", line: 1 }]);
    const result = impact(base, index([]), { maxDepth: 1 });
    expect(result.files.some((file) => file.before?.file === "data.json")).toBe(true);
    expect(result.uncertainty.unresolvedEdges).toBe(1);
    expect(result.uncertainty.notes).toContain("indexed-graph-only");
    const limited = impact(base, index([card("b.ts", ["run"]), card("c.ts", ["top"]), card("data.json", [], "{}")]), { maxDepth: 1 });
    expect(limited.omitted.dependentFrontier).toBeGreaterThan(0);
  });

  it("keeps generation identity deterministic and sensitive to edges", () => {
    const a = card("a.ts", ["work"]), b = card("b.ts", ["run"]);
    expect(indexReceipt(index([a, b]))).toEqual(indexReceipt(index([b, a])));
    expect(indexReceipt(index([a, b])).generation).not.toBe(indexReceipt(index([a, b], [edge("b.ts#run", "a.ts#work")])).generation);
  });

  it("memoizes the receipt per index", () => {
    const repo = index([card("a.ts", ["work"]), card("b.ts", ["run"])]);
    expect(indexReceipt(repo)).toBe(indexReceipt(repo));
  });

  it("rejects malformed diffs rather than silently reporting no impact", () => {
    expect(() => impact(index([]), index([]), { diff: "not a diff" })).toThrow(/diff/);
    expect(() => impact(index([]), index([]), { diff: "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n" })).toThrow(/diff/);
    expect(() => impact(index([]), index([]), { diff: "--- a/../x.ts\n+++ b/x.ts" })).toThrow(/diff/);
  });

  it("does not assign a file rename when identical-content destinations are ambiguous", () => {
    const result = impact(index([card("old.ts", ["work"])]), index([card("a.ts", ["work"]), card("b.ts", ["work"])]));
    expect(result.changes.map((change) => change.kind).sort()).toEqual(["added", "added", "deleted"]);
  });

  it("uses explicit edited-file rename metadata and base source receipts", () => {
    const base = index([card("old.ts", ["work"]), card("caller.ts", ["run"])], [edge("caller.ts#run", "old.ts#work")]);
    const current = index([card("new.ts", ["work"], "function work() { return 2; }")]);
    const result = impact(base, current, { diff: "diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-function work() { return 1; }\n+function work() { return 2; }\n" });
    expect(result.changes.find((change) => change.kind === "renamed")?.basis).toBe("diff-rename");
    expect(result.changes.find((change) => change.kind === "renamed")?.before?.receipt.hash).toBe(base.files.get("old.ts")?.hash);
  });

  it("finds import dependents of changed non-symbol files and terminates cycles", () => {
    const files = [card("data.json", [], "{}"), card("loader.ts", ["load"]), card("app.ts", ["run"])];
    const edges: OsnovaEdge[] = [{ kind: "imports", fromFile: "loader.ts", fromSymbol: "loader.ts", toName: "./data.json", toFile: "data.json", line: 1,
      evidence: { source: "syntax", resolution: { status: "resolved", method: "import-path" } } },
    { kind: "imports", fromFile: "app.ts", fromSymbol: "app.ts", toName: "./loader", toFile: "loader.ts", line: 1,
      evidence: { source: "syntax", resolution: { status: "resolved", method: "import-path" } } },
    { kind: "imports", fromFile: "loader.ts", fromSymbol: "loader.ts", toName: "./app", toFile: "app.ts", line: 1,
      evidence: { source: "syntax", resolution: { status: "resolved", method: "import-path" } } }];
    const result = impact(index(files, edges), index([card("data.json", [], '{"changed":true}'), ...files.slice(1)], edges));
    expect(result.dependents.map((entry) => [entry.snapshot, entry.file, entry.depth])).toEqual([
      ["base", "loader.ts", 1], ["base", "app.ts", 2], ["current", "loader.ts", 1], ["current", "app.ts", 2],
    ]);
  });

  it("counts unresolved file targets instead of treating them as resolved dependencies", () => {
    const broken: OsnovaEdge = { ...edge("caller.ts#run", "a.ts#work"), evidence: { source: "syntax", resolution: { status: "ambiguous", candidates: ["a.ts#work", "b.ts#work"] } } };
    const base = index([card("a.ts", ["work"]), card("caller.ts", ["run"])], [broken]);
    const result = impact(base, index([card("caller.ts", ["run"])]));
    expect(result.dependents).toEqual([]);
    expect(result.uncertainty.unresolvedEdges).toBe(1);
  });

  it("retains hashes for intermediate re-export evidence", () => {
    const files = [card("a.ts", ["work"]), card("barrel.ts", []), card("caller.ts", ["run"])];
    const forwarded: OsnovaEdge = { ...edge("caller.ts#run", "a.ts#work"), evidence: { source: "syntax", resolution: { status: "resolved", method: "re-export-binding",
      via: [{ file: "barrel.ts", line: 1, kind: "named", exportedName: "work", importedName: "work", source: "./a", targetFile: "a.ts" }] } } };
    const result = impact(index(files, [forwarded]), index(files.slice(1)));
    expect(result.dependents[0]?.path[0]?.viaSources).toContainEqual(expect.objectContaining({ file: "barrel.ts", hash: files[1]?.hash }));
  });
});

describe("package scopes", () => {
  const files = [card("package.json", [], '{"name":"root"}'),
    card("packages/a/package.json", [], '{"name":"small"}'), card("packages/a/x.ts", ["work"]),
    card("packages/ab/package.json", [], '{"name":"large"}'), ...Array.from({ length: 12 }, (_, i) => card(`packages/ab/${i}.ts`, ["work"])),
    card("rust/Cargo.toml", [], '[package]\nname = "worker"'), card("py/pyproject.toml", [], '[project]\nname = "python-worker"')];

  it("detects indexed manifests and spreads hits across scopes", () => {
    const repo = index(files);
    expect(detectScopes(repo).map((scope) => scope.path)).toEqual(["", "packages/a", "packages/ab", "py", "rust"]);
    const result = scopedAsk(repo, "work", { limit: 2 });
    expect(new Set(result.hits.map((hit) => hit.scope))).toEqual(new Set(["packages/a", "packages/ab"]));
    expect(result.omittedHits).toBeGreaterThan(0);
  });

  it("uses segment boundaries, isolated edges and global-relative paths", () => {
    const result = scopedAsk(index(files, [edge("packages/ab/0.ts#work", "packages/a/x.ts#work")]), "work", { in: "packages/a/", limit: 20 });
    expect(result.hits.map((hit) => hit.file)).toEqual(["packages/a/x.ts"]);
    expect(result.filesSearched).toBe(2);
    expect(scopedAsk(index(files), "work", { in: "packages/missing" }).hits).toEqual([]);
    expect(() => scopedAsk(index(files), "work", { in: "../packages" })).toThrow(/scope/);
    expect(() => scopedAsk(index(files), "work", { in: "/" })).toThrow(/scope/);
  });

  it("keeps nearest nested package ownership and fallback repository retrieval", () => {
    const repo = index([card("root.ts", ["work"]), card("pkg/package.json", [], "invalid json"), card("pkg/a.ts", ["work"]),
      card("pkg/nested/pyproject.toml", [], "[project]"), card("pkg/nested/a.ts", ["work"])]);
    const result = scopedAsk(repo, "work", { limit: 20 });
    expect(result.hits.map((hit) => [hit.file, hit.scope])).toEqual([
      ["root.ts", ""], ["pkg/a.ts", "pkg"], ["pkg/nested/a.ts", "pkg/nested"],
    ]);
    expect(scopedAsk(repo, "work", { limit: 0 }).omittedHits).toBe(3);
    expect(scopedAsk(index([...repo.files.values()].reverse()), "work", { limit: 20 })).toEqual(result);
  });
});

describe("task context", () => {
  const repo = index([card("src/work.ts", ["work"]), card("src/mid.ts", ["middle"]),
    card("test/actual.test.ts", ["check"]), card("test/unrelated.test.ts", ["work"]), card("test/heuristic.test.ts", ["check"])],
  [edge("src/mid.ts#middle", "src/work.ts#work"), edge("test/actual.test.ts#check", "src/mid.ts#middle"),
    { ...edge("test/heuristic.test.ts#check", "src/work.ts#work"), evidence: { source: "syntax", resolution: { status: "resolved", method: "unique-name" } } }]);

  it.each(["understand", "change", "review"] as const)("assembles %s definitions, reliable relationships and edge-backed tests", (task) => {
    const result = taskContext(repo, { task, question: "work", symbols: ["src/work.ts#work"], maxCodeUnits: 20_000 });
    expect(result.definitions.some((entry) => entry.symbol.qualifiedName === "src/work.ts#work")).toBe(true);
    expect(result.relationships.length).toBeGreaterThan(0);
    expect(result.candidateTests.map((entry) => entry.file)).toEqual(["test/actual.test.ts"]);
    expect(result.candidateTests[0]?.path).toHaveLength(2);
    expect(result.candidateTests[0]?.receipt.hash).toBe(repo.files.get("test/actual.test.ts")?.hash);
    expect(result.omitted.uncertainEdges).toBe(1);
  });

  it("caps complete serialized UTF-16 output deterministically, retaining receipts and omissions", () => {
    const options = { task: "change" as const, question: "work", symbols: ["src/work.ts#work"], maxCodeUnits: 1600 };
    const result = taskContext(repo, options);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1600);
    expect(taskContext(repo, options)).toEqual(result);
    expect(result.receipt.generation).toBe(indexReceipt(repo).generation);
    expect(result.omitted.definitions + result.omitted.relationships + result.omitted.candidateTests).toBeGreaterThan(0);
    expect(result.sources).toContainEqual(expect.objectContaining({ file: "src/work.ts", hash: repo.files.get("src/work.ts")?.hash }));
    expect(() => taskContext(repo, { ...options, maxCodeUnits: 0 })).toThrow(/budget/);
  });

  it("prevents cross-scope definitions, relationships and test leakage", () => {
    const result = taskContext(repo, { task: "review", question: "work", symbols: ["src/work.ts#work"], in: "src" });
    expect(result.candidateTests).toEqual([]);
    expect(result.relationships.every((entry) => entry.edge.fromFile.startsWith("src/"))).toBe(true);
    expect(result.omitted.outOfScopeEdges).toBeGreaterThan(0);
  });

  it("retrieves seeds when omitted and does not traverse beyond its depth", () => {
    const result = taskContext(repo, { task: "change", question: "middle", limit: 1, maxDepth: 0 });
    expect(result.definitions[0]?.symbol.name).toBe("middle");
    expect(result.relationships).toEqual([]);
    expect(result.candidateTests).toEqual([]);
    expect(result.omitted.depthFrontier).toBeGreaterThan(0);
  });

  it("excludes unresolved same-name tests and preserves diagnostic limitations", () => {
    const files = [card("a.ts", ["work"]), { ...card("test/work.test.ts", ["work"]), diagnostics: [{ phase: "parse" as const, path: "test/work.test.ts", code: "partial" }] }];
    const unresolved: OsnovaEdge = { kind: "calls", fromFile: "test/work.test.ts", fromSymbol: "test/work.test.ts#work", toName: "work", line: 1,
      evidence: { source: "syntax", resolution: { status: "unresolved", reason: "binding-blocked" } } };
    const result = taskContext(index(files, [unresolved]), { task: "review", question: "work", symbols: ["a.ts#work", "missing"] });
    expect(result.candidateTests).toEqual([]);
    expect(result.omitted.unknownSymbols).toBe(1);
    expect(result.omitted.uncertainEdges).toBe(1);
    expect(result.limitations).toContain("index-diagnostics-present");
  });

  it("measures astral source text as UTF-16 and retains exact-fit output", () => {
    const unicode = index([card("a.ts", ["work"], 'function work() { return "\u{1f680}"; }')]);
    const options = { task: "understand" as const, question: "work", symbols: ["a.ts#work"] };
    const full = taskContext(unicode, options);
    const length = JSON.stringify(full).length;
    expect(taskContext(unicode, { ...options, maxCodeUnits: length })).toEqual(full);
    const clipped = taskContext(unicode, { ...options, maxCodeUnits: length - 1 });
    expect(JSON.stringify(clipped).length).toBeLessThanOrEqual(length - 1);
    expect(clipped.omitted.definitions).toBe(1);
    expect(clipped.sources).toEqual(full.sources);
  });

  it("follows real extracted alias edges across files, not same-name test text", async () => {
    const texts = new Map([
      ["src/work.ts", "export function work() { return 1; }"],
      ["src/middle.ts", 'import { work as renamed } from "./work";\nexport function middle() { return renamed(); }'],
      ["test/actual.test.ts", 'import { middle } from "../src/middle";\nexport function check() { return middle(); }'],
      ["test/unrelated.test.ts", "export function work() { return 0; }"],
    ]);
    const files = new Map<string, FileCard>(), rawEdges = new Map<string, readonly RawEdgeItem[]>();
    const parser = await getParser("typescript");
    for (const [file, text] of texts) {
      const tree = parser.parse(text)!;
      try {
        const output = adapterFor("typescript").extract(tree, text);
        files.set(file, { ...card(file, [], text), language: "typescript", symbols: output.definitions.map((definition) => ({
          ...definition, file, qualifiedName: `${file}#${definition.parent ? `${definition.parent}.` : ""}${definition.name}`,
          lineCount: definition.span.endLine - definition.span.startLine + 1,
        })) });
        rawEdges.set(file, output.edges);
      } finally { tree.delete(); }
    }
    const extracted = new OsnovaIndexImpl("/fixture", files, resolveEdges({ root: "/fixture", files, rawEdges }));
    const result = taskContext(extracted, { task: "change", question: "work", symbols: ["src/work.ts#work"], maxCodeUnits: 30_000 });
    expect(result.candidateTests.map((candidate) => candidate.file)).toEqual(["test/actual.test.ts"]);
    expect(result.candidateTests[0]?.path.map((step) => step.edge.fromFile)).toEqual(["src/middle.ts", "test/actual.test.ts"]);
    const deleted = impact(extracted, new OsnovaIndexImpl("/fixture", new Map([...files].filter(([file]) => file !== "src/work.ts")), []));
    expect(deleted.dependents.some((dependent) => dependent.snapshot === "base" && dependent.file === "test/actual.test.ts")).toBe(true);
  });
});

import { expect, it } from "vitest";
import { formatIndexDiagnostics, formatIndexHealthSummary } from "../src/query/format.js";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import type { FileCard, IndexDiagnostic, OsnovaIndex } from "../src/types.js";

function index(diagnostics: IndexDiagnostic[]) {
  const files = new Map<string, FileCard>();
  for (const diagnostic of diagnostics) {
    files.set(diagnostic.path, {
      path: diagnostic.path, language: "typescript", hash: "fixture", size: 0, lineCount: 0,
      text: "", symbols: [], diagnostics: [diagnostic], reExports: [],
    });
  }
  return new OsnovaIndexImpl("/fixture", files, []);
}

it("compresses repeated diagnostics without exposing per-file paths", () => {
  const target = index(Array.from({ length: 43 }, (_, number) => ({
    phase: "parse" as const, path: `private/file-${number}.py`, code: "syntax-errors",
  })));
  const summary = formatIndexHealthSummary(target);
  expect(summary).toBe("partial analysis: 43 diagnostics (parse/syntax-errors=43); results may be incomplete; details via doctor or indexHealth");
  expect(summary).not.toContain("private/file-");
  expect(formatIndexDiagnostics(target)).toContain("private/file-0.py");
});

it("sorts and bounds diagnostic categories deterministically", () => {
  const target = index([
    { phase: "read", path: "a", code: "unreadable" },
    { phase: "parse", path: "b", code: "syntax-errors" },
    { phase: "cache", path: "c", code: "busy" },
    { phase: "scan", path: "d", code: "changing" },
    { phase: "parse", path: "e", code: "extraction-failed" },
  ]);
  const summary = formatIndexHealthSummary(target);
  expect(summary).toContain("cache/busy=1, parse/extraction-failed=1, parse/syntax-errors=1, read/unreadable=1, +1 categories");
  expect(summary.split("\n")).toHaveLength(1);
  expect(formatIndexHealthSummary(target)).toBe(summary);
});

it("keeps fresh output empty and unverified health explicit", () => {
  expect(formatIndexHealthSummary(index([]))).toBe("");
  const target = index([]);
  const custom: OsnovaIndex = {
    root: target.root, files: target.files, symbols: target.symbols, edges: target.edges, diagnostics: undefined,
    incoming: target.incoming.bind(target), outgoing: target.outgoing.bind(target), edgesForFile: target.edgesForFile.bind(target),
  };
  expect(formatIndexHealthSummary(custom)).toBe("analysis health unverified; details via doctor or indexHealth");
});

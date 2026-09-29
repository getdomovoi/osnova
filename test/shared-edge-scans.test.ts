import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import type { FileCard, OsnovaEdge, OsnovaSymbol } from "../src/types.js";
import { unresolvedCallsByName } from "../src/query/callers.js";
import { collectTestImports } from "../src/query/tests.js";

function card(path: string, names: string[]): FileCard {
  const text = `${names.map((name) => `function ${name}() { return 1; }`).join("\n")}\n`;
  const symbols: OsnovaSymbol[] = names.map((name, i) => ({ name, qualifiedName: `${path}#${name}`, file: path,
    kind: "function", signature: `function ${name}()`, lineCount: 1,
    span: { startLine: i + 1, endLine: i + 1, startCol: 0, endCol: (text.split("\n")[i] ?? "").length } }));
  return { path, symbols, text, hash: createHash("sha256").update(text).digest("hex"),
    language: "typescript", size: text.length, lineCount: text.split("\n").length };
}

const unresolved = (from: string, name: string): OsnovaEdge => ({ kind: "calls", fromFile: from.split("#")[0]!, fromSymbol: from, toName: name,
  line: 1, evidence: { source: "syntax", resolution: { status: "unresolved", reason: "no-matching-symbol" } } });
const testImport = (testFile: string, target: string): OsnovaEdge => ({ kind: "imports", fromFile: testFile, fromSymbol: `${testFile}#<module>`,
  toName: target, toFile: target, line: 1, evidence: { source: "syntax", resolution: { status: "resolved", method: "import-binding" } } });

// Caller, reach and test answers each rescanned every edge; on an 18,425-file index that is about 94 ms and 25 ms per call.
describe("edge scans shared across calls on one index", () => {
  const files = new Map([["a.ts", card("a.ts", ["target", "helper"])], ["a.test.ts", card("a.test.ts", ["check"])]]);
  const before = new OsnovaIndexImpl("/fixture", files, [unresolved("a.ts#helper", "target"), testImport("a.test.ts", "a.ts")]);
  const after = new OsnovaIndexImpl("/fixture", files, [unresolved("a.ts#helper", "target"), unresolved("a.test.ts#check", "target"), testImport("a.test.ts", "a.ts")]);

  it("returns the same unresolved-name and test-import maps on a repeated call", () => {
    expect(unresolvedCallsByName(before)).toBe(unresolvedCallsByName(before));
    expect(collectTestImports(before)).toBe(collectTestImports(before));
  });

  it("builds fresh maps for a refreshed index and keeps the old index's answer", () => {
    expect(unresolvedCallsByName(before).get("target")?.length).toBe(1);
    expect(unresolvedCallsByName(after).get("target")?.length).toBe(2);
    expect(unresolvedCallsByName(before).get("target")?.length).toBe(1);
    expect([...(collectTestImports(after).get("a.ts")?.keys() ?? [])]).toEqual(["a.test.ts"]);
  });
});

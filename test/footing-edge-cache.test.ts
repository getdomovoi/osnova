import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import type { FileCard, OsnovaEdge, OsnovaSymbol } from "../src/types.js";
import { taskContext } from "../src/query/task-context.js";

function card(path: string, names: string[]): FileCard {
  const text = `${names.map((name) => `function ${name}() { return 1; }`).join("\n")}\n`;
  const symbols: OsnovaSymbol[] = names.map((name, i) => ({ name, qualifiedName: `${path}#${name}`, file: path,
    kind: "function", signature: `function ${name}()`, lineCount: 1,
    span: { startLine: i + 1, endLine: i + 1, startCol: 0, endCol: (text.split("\n")[i] ?? "").length } }));
  return { path, symbols, text, hash: createHash("sha256").update(text).digest("hex"),
    language: "typescript", size: text.length, lineCount: text.split("\n").length };
}

function edge(from: string, to: string): OsnovaEdge {
  return { kind: "calls", fromFile: from.split("#")[0]!, fromSymbol: from, toName: to.split("#")[1]!,
    toSymbol: to, toFile: to.split("#")[0]!, line: 1,
    evidence: { source: "syntax", resolution: { status: "resolved", method: "import-binding" } } };
}

const callers = (result: ReturnType<typeof taskContext>): string[] =>
  result.relationships.map((relationship) => `${relationship.edge.fromSymbol} -> ${relationship.edge.toSymbol}`).sort();

// Footing reuses its edge maps between calls on one index; these cases pin that reuse to the index and scope it was built for.
describe("footing across repeated calls and refreshes", () => {
  const before = new OsnovaIndexImpl("/fixture", new Map([["a.ts", card("a.ts", ["target"])], ["lib/b.ts", card("lib/b.ts", ["middle"])]]),
    [edge("lib/b.ts#middle", "a.ts#target")]);
  const after = new OsnovaIndexImpl("/fixture", new Map([["a.ts", card("a.ts", ["target"])], ["lib/b.ts", card("lib/b.ts", ["middle"])],
    ["lib/c.ts", card("lib/c.ts", ["newcaller"])]]), [edge("lib/b.ts#middle", "a.ts#target"), edge("lib/c.ts#newcaller", "a.ts#target")]);
  const ask = { task: "change" as const, question: "", symbols: ["a.ts#target"] };

  it("answers the same on a repeated call", () => {
    expect(taskContext(before, ask)).toEqual(taskContext(before, ask));
  });

  it("shows a caller that a refresh added, then still answers the old index as before", () => {
    const first = callers(taskContext(before, ask));
    expect(callers(taskContext(after, ask))).toEqual(["lib/b.ts#middle -> a.ts#target", "lib/c.ts#newcaller -> a.ts#target"]);
    expect(callers(taskContext(before, ask))).toEqual(first);
  });

  it("keeps each scope's out-of-scope count after another scope was answered", () => {
    const whole = taskContext(after, ask);
    const scoped = taskContext(after, { ...ask, in: "a.ts" });
    expect(whole.omitted.outOfScopeEdges).toBe(0);
    expect(scoped.omitted.outOfScopeEdges).toBe(2);
    expect(taskContext(after, ask).omitted.outOfScopeEdges).toBe(0);
  });

  it("shares one evidence object per edge across scopes", () => {
    const inner = new OsnovaIndexImpl("/fixture", new Map([["lib/b.ts", card("lib/b.ts", ["middle"])], ["lib/c.ts", card("lib/c.ts", ["caller"])]]),
      [edge("lib/c.ts#caller", "lib/b.ts#middle")]);
    const question = { task: "change" as const, question: "", symbols: ["lib/b.ts#middle"] };
    const whole = taskContext(inner, question).relationships;
    const inLib = taskContext(inner, { ...question, in: "lib" }).relationships;
    expect(whole).toHaveLength(1);
    expect(inLib[0]).toBe(whole[0]);
  });

  it("answers correctly after many scopes have been asked", () => {
    const first = taskContext(after, { ...ask, in: "a.ts" });
    for (let i = 0; i < 20; i++) taskContext(after, { ...ask, in: `missing${i}` });
    expect(taskContext(after, { ...ask, in: "a.ts" })).toEqual(first);
  });
});

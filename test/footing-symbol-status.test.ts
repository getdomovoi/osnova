import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import type { FileCard, OsnovaSymbol } from "../src/types.js";
import { taskContext } from "../src/query/task-context.js";
import { formatTaskContext } from "../src/query/format.js";

function card(path: string, names: string[], bodyLines = 1): FileCard {
  const body = Array.from({ length: bodyLines }, (_, i) => `  const value${i} = compute${i}(input);`).join("\n");
  const blocks = names.map((name) => `function ${name}(input) {\n${body}\n}`);
  const text = `${blocks.join("\n")}\n`;
  let line = 1;
  const symbols: OsnovaSymbol[] = names.map((name) => {
    const span = { startLine: line, endLine: line + bodyLines + 1, startCol: 0, endCol: 1 };
    line += bodyLines + 2;
    return { name, qualifiedName: `${path}#${name}`, file: path, kind: "function", signature: `function ${name}(input)`, lineCount: bodyLines + 2, span };
  });
  return { path, symbols, text, hash: createHash("sha256").update(text).digest("hex"), language: "typescript", size: text.length, lineCount: line };
}

const index = new OsnovaIndexImpl("/fixture", new Map([
  ["a.ts", card("a.ts", ["one", "big"], 30)], ["lib/b.ts", card("lib/b.ts", ["two"])],
]), []);

// A batch of named symbols used to report its misses as one "unknown symbols" count; each requested name
// now carries its own status, so an agent knows which name to fix instead of retrying the whole batch.
describe("footing status per requested symbol", () => {
  it("marks each requested name returned, unknown or outside the scope", () => {
    const result = taskContext(index, { task: "understand", question: "", symbols: ["lib/b.ts#two", "a.ts#one", "a.ts#missing"], in: "a.ts" });
    expect(result.requested).toEqual([
      { name: "a.ts#missing", status: "unknown" },
      { name: "a.ts#one", status: "returned" },
      { name: "lib/b.ts#two", status: "out-of-scope" },
    ]);
    expect(formatTaskContext(result)).toContain("requested: a.ts#missing unknown; a.ts#one returned; lib/b.ts#two out-of-scope");
  });

  it("marks a found name omitted when its definition does not fit the budget", () => {
    const measure = (value: Parameters<typeof formatTaskContext>[0]): number => formatTaskContext(value).length;
    const small = taskContext(index, { task: "understand", question: "", symbols: ["a.ts#big"], maxCodeUnits: 700, measure });
    expect(small.definitions).toEqual([]);
    expect(small.requested).toEqual([{ name: "a.ts#big", status: "omitted" }]);
  });

  it("adds no status list to a question without named symbols", () => {
    const result = taskContext(index, { task: "understand", question: "one" });
    expect(result.requested).toBeUndefined();
    expect(formatTaskContext(result)).not.toContain("requested:");
  });
});

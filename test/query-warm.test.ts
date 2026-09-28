import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import type { FileCard, OsnovaSymbol } from "../src/types.js";
import { fileDocumentsCached, queryContext, resetQueryCaches, warmQueryContext } from "../src/query/context.js";

function card(path: string, name: string): FileCard {
  const text = `export function ${name}() {\n  return "${name}";\n}\n`;
  const symbols: OsnovaSymbol[] = [{ name, qualifiedName: `${path}#${name}`, file: path, kind: "function",
    signature: `export function ${name}()`, lineCount: 3, span: { startLine: 1, endLine: 3, startCol: 0, endCol: 1 } }];
  return { path, symbols, text, hash: createHash("sha256").update(text).digest("hex"),
    language: "typescript", size: text.length, lineCount: 4 };
}

const files = Array.from({ length: 40 }, (_, i) => card(`src/file${i}.ts`, `handler${i}`));
// A new index object per test: the corpus is cached per index object, so reusing one would let a test read the context
// an earlier test finished.
const fresh = (): OsnovaIndexImpl => new OsnovaIndexImpl("/fixture", new Map(files.map((file) => [file.path, file])), []);

// The MCP server warms the ranking corpus between requests; these cases pin that it yields and ends in the same context.
describe("warming the query context", () => {
  beforeEach(() => resetQueryCaches());

  it("yields to the event loop while it builds, then returns the context queries use", async () => {
    const index = fresh();
    let ticks = 0;
    let done = false;
    const tick = (): void => { ticks += 1; if (!done) setImmediate(tick); };
    setImmediate(tick);
    const warmed = await warmQueryContext(index, { sliceMs: 0 });
    done = true;
    expect(ticks).toBeGreaterThan(10);
    expect(queryContext(index)).toBe(warmed);
    expect(files.every((file) => fileDocumentsCached(index, file.path))).toBe(true);
  });

  it("stops when cancelled, and the next query builds the rest into the same context a cold query gets", async () => {
    const index = fresh();
    let calls = 0;
    const warmed = await warmQueryContext(index, { sliceMs: 0, cancelled: () => ++calls > 3 });
    expect(warmed).toBeUndefined();
    expect(files.filter((file) => fileDocumentsCached(index, file.path))).toHaveLength(3);
    const finished = queryContext(index);
    expect(files.every((file) => fileDocumentsCached(index, file.path))).toBe(true);
    resetQueryCaches();
    const cold = queryContext(fresh());
    expect(finished.documentCount).toBe(cold.documentCount);
    expect([...finished.df.entries()]).toEqual([...cold.df.entries()]);
  });
});

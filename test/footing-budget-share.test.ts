import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import type { FileCard, OsnovaEdge, OsnovaSymbol } from "../src/types.js";
import { taskContext } from "../src/query/task-context.js";
import { formatTaskContext } from "../src/query/format.js";

// Eight 13-line "start" functions, each with a short helper it calls: the shape where seed excerpts alone
// used to fill footing's budget and leave no relationships.
function card(i: number): FileCard {
  const path = `src/host${i}.ts`;
  const body = Array.from({ length: 10 }, (_, line) => `  const step${line} = prepare${line}(options, context, registry);`).join("\n");
  const text = `export function startHost${i}(options) {\n${body}\n  return helper${i}(options);\n}\nexport function helper${i}(options) { return options; }\n`;
  const symbols: OsnovaSymbol[] = [
    { name: `startHost${i}`, qualifiedName: `${path}#startHost${i}`, file: path, kind: "function",
      signature: `export function startHost${i}(options)`, lineCount: 13, span: { startLine: 1, endLine: 13, startCol: 0, endCol: 1 } },
    { name: `helper${i}`, qualifiedName: `${path}#helper${i}`, file: path, kind: "function",
      signature: `export function helper${i}(options)`, lineCount: 1, span: { startLine: 14, endLine: 14, startCol: 0, endCol: 50 } },
  ];
  return { path, symbols, text, hash: createHash("sha256").update(text).digest("hex"), language: "typescript", size: text.length, lineCount: 15 };
}

function edge(i: number): OsnovaEdge {
  const path = `src/host${i}.ts`;
  return { kind: "calls", fromFile: path, fromSymbol: `${path}#startHost${i}`, toName: `helper${i}`, toSymbol: `${path}#helper${i}`,
    toFile: path, line: 12, evidence: { source: "syntax", resolution: { status: "resolved", method: "import-binding" } } };
}

const files = Array.from({ length: 8 }, (_, i) => card(i));
const index = new OsnovaIndexImpl("/fixture", new Map(files.map((file) => [file.path, file])), files.map((_, i) => edge(i)));
// The MCP server's own footing settings: 8-line excerpts, seeds of up to 40 lines kept whole, measured as formatted text.
const mcpShape = { maxCodeUnits: 4096, excerptLines: 8, inlineShortDefinitions: 40, measure: (result: Parameters<typeof formatTaskContext>[0]) => formatTaskContext(result).length };

describe("footing budget between seeds and relationships", () => {
  it("keeps room for relationships when seed excerpts alone would fill the budget", () => {
    const result = taskContext(index, { task: "understand", question: "start host", ...mcpShape });
    expect(result.definitions.length).toBeGreaterThan(0);
    expect(result.relationships.length).toBeGreaterThan(0);
  });

  it("still gives seeds the whole budget when there are no relationships", () => {
    const alone = new OsnovaIndexImpl("/fixture", new Map(files.map((file) => [file.path, file])), []);
    const withoutEdges = taskContext(alone, { task: "understand", question: "start host", ...mcpShape });
    expect(withoutEdges.relationships).toEqual([]);
    expect(formatTaskContext(withoutEdges).length).toBeGreaterThan(0.8 * mcpShape.maxCodeUnits);
  });
});

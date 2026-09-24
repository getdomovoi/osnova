import { afterAll, beforeAll, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildIndex } from "../src/index/build.js";
import type { OsnovaIndex } from "../src/types.js";
import { findTextDetailed } from "../src/query/findText.js";
import { taskContext } from "../src/query/task-context.js";
import { formatFindTextResult, formatTaskContext } from "../src/query/format.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/cli.js";

let temporary: string;
let workspace: string;
let cacheDir: string;
let index: OsnovaIndex;
const files = {
  "src/pricing.js": "export function orderTotal(price, quantity, discount) {\n  return Math.round(price * quantity * (1 - discount) * 100) / 100;\n}\n",
  "src/checkout.js": "import { orderTotal } from './pricing.js';\nexport function checkout(price, quantity, discount) {\n  return orderTotal(price, quantity, discount);\n}\n",
  "src/preview.js": "import { orderTotal } from './pricing.js';\nexport function preview(price, quantity) {\n  return orderTotal(price, quantity, 0);\n}\n",
  "test/pricing.test.js": "import { orderTotal } from '../src/pricing.js';\norderTotal(10, 2, 0.25);\n",
  "src/unknown.js": "export function unknown(value) {\n  return value.orderTotal(10, 2, 0);\n}\n",
  "src/mixed.js": "import { orderTotal } from './pricing.js';\nexport function other() { return 1; }\nconst label = 'orderTotal'; other();\n// orderTotal is only a comment here\n",
  "src/long.js": "import { orderTotal } from './pricing.js';\nexport function long(price, quantity, discount) {\n" + "\n".repeat(12) + "  return orderTotal(price, quantity, discount);\n}\n",
  "src/wide.js": "export function wide(value) { return value; }\n",
  "test/wide.test.js": "import { wide } from '../src/wide.js';\nwide(\"" + "a".repeat(233) + "😀\");\n",
  "src/labels.js": "function one() {}\nfunction two() {}\nfunction three() {}\nfunction four() {}\n'needle'; one(); two(); three(); four();\n",
};

beforeAll(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-source-evidence-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(workspace, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text);
  }
  index = await buildIndex(workspace, { cacheDir });
});

afterAll(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

it("distinguishes definitions, imports and resolved test calls without changing text matches", () => {
  const result = findTextDetailed(index, "orderTotal", { fixed: true });
  const original = structuredClone(result);
  const text = formatFindTextResult(result, index);
  expect(text).toContain("defines src/pricing.js#orderTotal");
  expect(text).toContain("imports ./pricing.js");
  expect(text).toContain("include direct test calls in the same caller list");
  expect(text).toContain("test/pricing.test.js:2:1: orderTotal(10, 2, 0.25);\n  line evidence: direct call to src/pricing.js#orderTotal [import-binding; test caller]");
  expect(text).toContain("src/unknown.js:2:16: return value.orderTotal(10, 2, 0);\n  line evidence: call orderTotal [receiver-unresolved]");
  expect(result).toEqual(original);
  expect(findTextDetailed(index, "orderTotal", { fixed: true })).toEqual(original);
});

it("does not classify a text occurrence by an unrelated call on the same line", () => {
  const result = findTextDetailed(index, "orderTotal", { in: "src/mixed.js", fixed: true });
  const text = formatFindTextResult(result, index);
  expect(text).toContain("Line evidence is not per-match classification");
  const mixed = text.split("\n").find((line) => line.includes("direct call to src/mixed.js#other"));
  expect(mixed).toBeDefined();
  expect(text).not.toContain("direct call to src/pricing.js#orderTotal");
  expect(text).toContain("src/mixed.js:4:4: // orderTotal is only a comment here");
});

it("counts omitted line labels without changing match counts", () => {
  const result = findTextDetailed(index, "needle", { fixed: true });
  const text = formatFindTextResult(result, index);
  expect(text).toContain("1/1 matches, 1/1 groups");
  expect(text).toContain("+1 labels omitted");
  expect(text.match(/direct call to src\/labels.js#/g)).toHaveLength(3);
});

it("bounds long call lines with exact clipping counts and intact surrogate pairs", () => {
  const result = taskContext(index, { task: "review", question: "", symbols: ["src/wide.js#wide"], maxCodeUnits: 4096,
    measure: (partial) => formatTaskContext(partial).length });
  const line = files["test/wide.test.js"].split("\n")[1]!;
  const excerpt = result.relationships.find((item) => item.edge.fromFile === "test/wide.test.js")?.excerpt;
  expect(excerpt).toBe(`${line.slice(0, 239)}… [+${line.length - 239} code units]`);
  expect(excerpt).not.toContain("\ud83d");
  expect(formatTaskContext(result)).toContain(excerpt);
});

it("quotes uncovered call sites while preserving forwarded arguments and avoiding duplicate source", () => {
  const result = taskContext(index, { task: "review", question: "", symbols: ["src/pricing.js#orderTotal"],
    maxCodeUnits: 4096, excerptLines: 8, inlineShortDefinitions: 40, measure: (partial) => formatTaskContext(partial).length });
  const text = formatTaskContext(result);
  expect(text).toContain("reuse unchanged spans");
  expect(text).toContain("return orderTotal(price, quantity, discount);");
  expect(text).toContain("return orderTotal(price, quantity, 0);");
  expect(text).toContain("test/pricing.test.js -> src/pricing.js#orderTotal calls line 2 [import-binding; test]");
  expect(text).toContain("test/pricing.test.js:2: orderTotal(10, 2, 0.25);");
  expect(text).toContain("src/long.js:15: return orderTotal(price, quantity, discount);");
  expect(text).not.toContain("src/checkout.js:3: return");
  expect(text).not.toContain("src/preview.js:3: return");
  expect(text.length).toBeLessThanOrEqual(4096);
  expect(result.omitted.uncertainEdges).toBeGreaterThan(0);
});

it("keeps exact omission counts when call-site source and provenance use the output budget", () => {
  const full = taskContext(index, { task: "review", question: "", symbols: ["src/pricing.js#orderTotal"], maxCodeUnits: 100_000 });
  for (const budget of [900, 1200, 1800]) {
    const options = { task: "review" as const, question: "", symbols: ["src/pricing.js#orderTotal"], maxCodeUnits: budget,
      excerptLines: 8, inlineShortDefinitions: 40, measure: (partial: Parameters<typeof formatTaskContext>[0]) => formatTaskContext(partial).length };
    const result = taskContext(index, options);
    expect(formatTaskContext(result).length).toBeLessThanOrEqual(budget);
    expect(result.relationships.length + result.omitted.relationships).toBe(full.relationships.length);
    expect(result.definitions.length + result.omitted.definitions).toBe(full.definitions.length);
    expect(result.candidateTests.length + result.omitted.candidateTests).toBe(full.candidateTests.length);
    expect(taskContext(index, options)).toEqual(result);
  }
});

it("keeps structural evidence when optional call details cannot fit", () => {
  for (const budget of [900, 1200, 1800, 4096]) {
    const options = { task: "review" as const, question: "", symbols: ["src/pricing.js#orderTotal"], maxCodeUnits: budget,
      excerptLines: 8, inlineShortDefinitions: 40 };
    const core = taskContext(index, { ...options, measure: (partial) => formatTaskContext({ ...partial,
      relationships: partial.relationships.map((relationship) => ({ ...relationship, excerpt: undefined })) }).length });
    const detailed = taskContext(index, { ...options, measure: (partial) => formatTaskContext(partial).length });
    expect(detailed.omitted).toEqual(core.omitted);
    expect(detailed.definitions.map((item) => item.symbol.qualifiedName)).toEqual(core.definitions.map((item) => item.symbol.qualifiedName));
    expect(detailed.relationships.map((item) => item.edge)).toEqual(core.relationships.map((item) => item.edge));
    expect(detailed.candidateTests).toEqual(core.candidateTests);
    expect(formatTaskContext(detailed).length).toBeLessThanOrEqual(budget);
  }
});

it("serves the same call evidence through CLI and MCP with bounded footing", async () => {
  const output: string[] = [];
  expect(await runCli(["thread", "orderTotal", "--workspace", workspace, "--cache-dir", cacheDir],
    { stdout: (value) => output.push(value), stderr: () => {} })).toBe(0);
  const { server, close } = createOsnovaMcpServer(workspace, { cacheDir });
  const client = new Client({ name: "source-evidence", version: "0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(right), client.connect(left)]);
    const search = await client.callTool({ name: "osnova_thread", arguments: { pattern: "orderTotal" } });
    const text = (search.content as { type: string; text: string }[]).map((item) => item.text).join("\n");
    expect(search.isError).toBeFalsy();
    expect(text.endsWith(output.join("\n"))).toBe(true);
    expect(text).toContain("direct call to src/pricing.js#orderTotal [import-binding; test caller]");
    const footing = await client.callTool({ name: "osnova_footing", arguments: { symbols: ["src/pricing.js#orderTotal"], task: "review" } });
    expect(footing.isError).toBeFalsy();
    const context = (footing.content as { type: string; text: string }[]).map((item) => item.text).join("\n");
    expect(context).toContain("test/pricing.test.js:2: orderTotal(10, 2, 0.25);");
    expect(context.length).toBeLessThanOrEqual(4096);
  } finally {
    await client.close();
    await server.close();
    close();
  }
});

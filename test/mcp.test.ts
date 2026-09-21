import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-mcp-ws-"));
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-mcp-cache-"));

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function connect(): Promise<Client> {
  const { server } = createOsnovaMcpServer(workspace, { cacheDir });
  const client = new Client({ name: "osnova-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, `${name} errored: ${JSON.stringify(result)}`).toBeFalsy();
  const content = (result as { content?: readonly ContentBlock[] }).content ?? [];
  const text = content.map((c) => (c.type === "text" ? c.text : "")).join("");
  expect(typeof text).toBe("string");
  return text;
}

describe("mcp stdio server", () => {
  it("exposes exactly the ten foundation tools", async () => {
    const client = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([
        "osnova_ground",
        "osnova_thread",
        "osnova_outline",
        "osnova_warp",
        "osnova_groundwork",
        "osnova_footing",
        "osnova_settle",
        "osnova_plumb",
        "osnova_tests",
        "osnova_unreferenced",
      ]);
      const byName = new Map(tools.map((t) => [t.name, t]));
      for (const [name, verb] of [
        ["osnova_ground", "Search:"], ["osnova_thread", "Text search:"], ["osnova_outline", "Outline:"],
        ["osnova_warp", "Call graph:"], ["osnova_groundwork", "Repository map:"],
        ["osnova_footing", "Task context:"], ["osnova_settle", "Change impact:"], ["osnova_plumb", "Check claims:"], ["osnova_tests", "Tests:"], ["osnova_unreferenced", "Unreferenced candidates:"],
      ] as const) {
        expect(byName.get(name)?.description?.startsWith(verb) ?? false, name).toBe(true);
      }
    } finally {
      await client.close();
    }
  });

  it("builds on first use and answers every tool round-trip", async () => {
    write("src/greet.ts", 'import { shout } from "./loud.js";\nexport function greet(name: string): string { return shout(`hello ${name}`); }\n');
    write("src/loud.ts", "export function shout(text: string): string { return text.toUpperCase(); }\n");

    const client = await connect();
    try {
      const askText = await callTool(client, "osnova_ground", { question: "greet name hello" });
      expect(askText).toContain("src/greet.ts");

      const findText = await callTool(client, "osnova_thread", { pattern: "toUpperCase", fixed: true });
      expect(findText).toContain("src/loud.ts");

      const skeleton = await callTool(client, "osnova_outline", { file: "src/greet.ts" });
      expect(skeleton).toContain("function greet");

      const callers = await callTool(client, "osnova_warp", { symbol: "src/loud.ts#shout" });
      expect(callers).toContain("src/greet.ts#greet");

      const mapCard = await callTool(client, "osnova_groundwork", {});
      expect(mapCard).toContain("osnova");
      expect(mapCard).toContain("files 2");
    } finally {
      await client.close();
    }
  }, 60_000);

  it("refreshes before answering when files changed on disk", async () => {
    write("src/greet.ts", 'import { shout } from "./loud.js";\nexport function greet(name: string): string { return shout(`hello ${name}`); }\n');
    write("src/loud.ts", "export function shout(text: string): string { return text.toUpperCase(); }\n");
    const client = await connect();
    try {
      const before = await callTool(client, "osnova_outline", { file: "src/greet.ts" });
      expect(before).not.toContain("farewell");

      write("src/greet.ts", 'import { shout } from "./loud.js";\nexport function farewell(): string { return shout("bye"); }\n');

      const after = await callTool(client, "osnova_outline", { file: "src/greet.ts" });
      const beforeGeneration = before.match(/osnova generation ([a-f0-9]{16})/)?.[1];
      const afterGeneration = after.match(/osnova generation ([a-f0-9]{16})/)?.[1];
      expect(beforeGeneration).toBeDefined();
      expect(afterGeneration).toBeDefined();
      expect(afterGeneration).not.toBe(beforeGeneration);
      expect(after).toContain("farewell");
      expect(after).not.toContain("function greet");
    } finally {
      await client.close();
    }
  }, 60_000);

  it("rejects the retired tool names", async () => {
    const client = await connect();
    try {
      for (const retired of ["osnova_ask", "osnova_find_text", "osnova_skeleton", "osnova_callers", "osnova_map"]) {
        const result = await client.callTool({ name: retired, arguments: { question: "x", pattern: "x", file: "x", symbol: "x" } });
        expect(result.isError, retired).toBe(true);
        const content = (result as { content?: readonly ContentBlock[] }).content ?? [];
        expect(content.map((c) => (c.type === "text" ? c.text : "")).join(""), retired).toBe(`osnova error: unknown tool ${JSON.stringify(retired)}`);
      }
    } finally {
      await client.close();
    }
  }, 60_000);

  it("answers footing and settle from the live index", async () => {
    write("src/greet.ts", 'import { shout } from "./loud.js";\nexport function greet(name: string): string { return shout(`hello ${name}`); }\n');
    write("src/loud.ts", "export function shout(text: string): string { return text.toUpperCase(); }\n");
    const client = await connect();
    try {
      const footing = await callTool(client, "osnova_footing", { question: "shout", task: "change" });
      expect(footing).toMatch(/^osnova generation [a-f0-9]{16}\nosnova footing: change, scope \., /);
      expect(footing).toContain("- src/loud.ts#shout function lines 1-1");
      expect(footing).toContain("- src/greet.ts#greet -> src/loud.ts#shout calls line 2");
      const bySymbol = await callTool(client, "osnova_footing", { symbols: ["src/loud.ts#shout"] });
      expect(bySymbol).toContain("osnova footing: understand,");
      const diff = "--- a/src/loud.ts\n+++ b/src/loud.ts\n@@ -1,1 +1,1 @@\n-export function shout(text: string): string { return text.toUpperCase(); }\n+export function shout(text: string): string { return text.toLowerCase(); }\n";
      const settle = await callTool(client, "osnova_settle", { diff });
      expect(settle).toContain("osnova settle: 1 symbol changes; 1 dependents; 0 frontier items omitted");
      expect(settle).toContain("changed: src/loud.ts#shout -> src/loud.ts#shout");
      expect(settle).toContain("current d1 src/greet.ts#greet");
      expect(settle).toMatch(/current d1 src\/greet\.ts#greet \[source [0-9a-f]{16}\]\n/);
      expect(settle).toContain("base = current index, deletions invisible");
      const bad = await client.callTool({ name: "osnova_settle", arguments: { diff: "not a diff" } });
      expect(bad.isError).toBe(true);
      const kinds = await callTool(client, "osnova_footing", { question: "shout", kinds: ["function"] });
      expect(kinds).toContain("src/loud.ts#shout");
      const badKind = await client.callTool({ name: "osnova_footing", arguments: { question: "shout", kinds: ["variable"] } });
      expect(badKind.isError).toBe(true);
      expect(JSON.stringify(badKind.content)).toContain("kinds must be symbol kinds");
      const missing = await client.callTool({ name: "osnova_footing", arguments: {} });
      expect(missing.isError).toBe(true);
      for (const args of [{ symbols: [] }, { question: "shout", task: 42 }, { question: "shout", task: "" }, { question: "shout", task: null }, { question: "shout", depth: "bad" },
        { question: "shout", depth: null }, { question: "shout", limit: "3" }, { symbols: ["src/loud.ts#shout", 7] }]) {
        const rejected = await client.callTool({ name: "osnova_footing", arguments: args });
        expect(rejected.isError, JSON.stringify(args)).toBe(true);
      }
      const long = await client.callTool({ name: "osnova_footing", arguments: { question: "shout", task: "x".repeat(9_000) } });
      expect(long.isError).toBe(true);
      const longContent = (long as { content?: readonly ContentBlock[] }).content ?? [];
      expect(longContent.map((c) => (c.type === "text" ? c.text : "")).join("").length).toBeLessThanOrEqual(8_192);
    } finally {
      await client.close();
    }
  }, 60_000);

  it("inlines short definitions in ground and footing so no read is needed", async () => {
    write("src/greet.ts", 'import { shout } from "./loud.js";\nexport function greet(name: string): string { return shout(`hello ${name}`); }\n');
    write("src/loud.ts", "export function shout(text: string): string {\n  const upper = text.toUpperCase();\n  return upper;\n}\n");
    const long = `export function tall(): number {\n${Array.from({ length: 60 }, (_, i) => `  const v${i} = ${i};`).join("\n")}\n  return v59;\n}\n`;
    write("src/tall.ts", long);
    const client = await connect();
    try {
      const ground = await callTool(client, "osnova_ground", { question: "shout" });
      expect(ground).toContain("L1: export function shout(text: string): string {");
      expect(ground).toContain("L4: }");
      expect(ground).not.toContain("excerpt: lines");
      const tallHit = await callTool(client, "osnova_ground", { question: "tall" });
      expect(tallHit).toContain("excerpt: lines");
      const footing = await callTool(client, "osnova_footing", { symbols: ["src/loud.ts#shout"], task: "change" });
      expect(footing).toContain("  return upper;\n  }");
      expect(footing).not.toContain("more lines]");
    } finally {
      await client.close();
    }
  }, 60_000);

  it("folds nested locals of a shown ground hit into an also line", async () => {
    write("src/fold.ts", "export function foldRoot(): number {\n  const foldLeft = 1;\n  const foldRight = 2;\n  return foldLeft + foldRight;\n}\n");
    const client = await connect();
    try {
      const text = await callTool(client, "osnova_ground", { question: "fold" });
      expect(text).toContain("src/fold.ts:1 function src/fold.ts#foldRoot");
      expect(text).toContain("also: .foldLeft L2, .foldRight L3");
      expect(text).not.toContain("constant src/fold.ts#foldRoot.foldLeft");
      const scoped = await callTool(client, "osnova_ground", { question: "foldLeft" });
      expect(scoped.indexOf("src/fold.ts:2 constant src/fold.ts#foldRoot.foldLeft")).toBeLessThan(scoped.indexOf("function src/fold.ts#foldRoot"));
      expect(scoped).toContain("also: .foldRight L3");
      expect(scoped).not.toContain("also: .foldLeft");
    } finally {
      await client.close();
    }
  }, 60_000);

  it("keeps the excerpt notice when inlining would overflow the ground budget", async () => {
    const wide = "x".repeat(50);
    for (let n = 0; n < 12; n++) write(`src/wide${n}.ts`, `export function wideFn${n}(): string {\n${Array.from({ length: 30 }, (_, i) => `  const a${i} = "${wide}";`).join("\n")}\n  return a0;\n}\n`);
    const client = await connect();
    try {
      const text = await callTool(client, "osnova_ground", { question: "wide", limit: 12 });
      expect(text.length).toBeLessThanOrEqual(16_384);
      expect(text).toContain("excerpt: lines");
      expect(text).not.toContain("[output truncated");
    } finally {
      await client.close();
    }
  }, 60_000);

  it("checks claimed call sites with plumb", async () => {
    write("src/greet.ts", 'import { shout } from "./loud.js";\nexport function greet(name: string): string { return shout(`hello ${name}`); }\n');
    write("src/loud.ts", "export function shout(text: string): string { return text.toUpperCase(); }\n");
    const client = await connect();
    try {
      const text = await callTool(client, "osnova_plumb", { symbol: "src/loud.ts#shout", sites: ["src/greet.ts:2", "src/greet.ts:1"] });
      expect(text).toContain("osnova plumb: src/loud.ts#shout, 1 confirmed, 0 name-only, 1 no-call, 0 not-indexed, 0 missing");
      expect(text).toContain("confirmed src/greet.ts:2 -> src/greet.ts#greet");
      expect(text).toContain("no-call src/greet.ts:1");
      const missing = await callTool(client, "osnova_plumb", { symbol: "src/loud.ts#shout", sites: ["src/greet.ts:1"] });
      expect(missing).toContain("missing:\nsrc/greet.ts:2 src/greet.ts#greet");
      for (const args of [{ symbol: "src/loud.ts#shout", sites: [] }, { symbol: "src/loud.ts#shout", sites: ["src/greet.ts"] }, { symbol: "src/loud.ts#shout" }, { symbol: "src/loud.ts#shout", sites: ["..\\greet.ts:1"] }]) {
        const rejected = await client.callTool({ name: "osnova_plumb", arguments: args });
        expect(rejected.isError, JSON.stringify(args)).toBe(true);
      }
    } finally {
      await client.close();
    }
  }, 60_000);

  it("maps tests to symbols and symbols to tests", async () => {
    write("src/greet.ts", 'import { shout } from "./loud.js";\nexport function greet(name: string): string { return shout(`hello ${name}`); }\n');
    write("src/loud.ts", "export function shout(text: string): string { return text.toUpperCase(); }\n");
    write("test/loud.test.ts", 'import { shout } from "../src/loud.js";\nexport const seen = shout("x");\n');
    write("test/greet.test.ts", 'import { greet } from "../src/greet.js";\nexport const name = "shout";\nexport const seenGreet = greet("x");\n');
    const client = await connect();
    try {
      const bySymbol = await callTool(client, "osnova_tests", { symbols: ["shout"] });
      expect(bySymbol).toMatch(/^osnova generation [a-f0-9]{16}\nosnova tests: 1 symbols; 1 test files with a resolved edge; 0 import the file only\n/);
      expect(bySymbol).toContain("function src/loud.ts#shout src/loud.ts:1: 1 test files with a resolved edge; 0 import the file only");
      expect(bySymbol).toContain("resolved edge (calls or references the symbol):\n- test/loud.test.ts");
      const greetOnly = await callTool(client, "osnova_tests", { symbols: ["greet"], includeImportOnly: false });
      expect(greetOnly).toContain("import-only files excluded");
      expect(greetOnly).not.toContain("loud.test.ts");
      expect(bySymbol).toContain("- test/loud.test.ts (resolved edge): test/loud.test.ts:2 calls import-binding");
      expect(bySymbol).not.toContain("greet.test.ts");
      expect(bySymbol).toContain("No indexed test is not proof of no test");
      const byFile = await callTool(client, "osnova_tests", { file: "test/greet.test.ts" });
      expect(byFile).toContain("osnova tests: test/greet.test.ts: 1 symbols under test, 1 imported files, 0 unresolved edges not listed");
      expect(byFile).toContain("- function src/greet.ts#greet src/greet.ts:2: test/greet.test.ts:3 calls import-binding");
      expect(byFile).toContain("imports:\n- src/greet.ts at test/greet.test.ts:1");
      const again = await callTool(client, "osnova_tests", { symbols: ["shout"] });
      expect(again).toBe(bySymbol);
      for (const args of [{}, { symbols: ["shout"], file: "test/loud.test.ts" }, { symbols: [] }, { file: "test/none.test.ts" }, { symbols: ["shout"], limit: "2" }, { symbols: ["shout"], includeImportOnly: "no" }]) {
        const rejected = await client.callTool({ name: "osnova_tests", arguments: args });
        expect(rejected.isError, JSON.stringify(args)).toBe(true);
      }
    } finally {
      await client.close();
      fs.rmSync(path.join(workspace, "test"), { recursive: true, force: true });
    }
  }, 60_000);

  it("lists unreferenced candidates with leads and the not-proof notice", async () => {
    write("src/lonely.ts", 'export function lonely(): number { return quiet(); }\nfunction quiet(): number { return 1; }\nfunction silent(): number { return 2; }\nfunction echo(): number { return 3; }\n');
    write("src/caller.ts", "export function caller(): number { return echo(); }\n");
    const client = await connect();
    try {
      const text = await callTool(client, "osnova_unreferenced", { scope: "src/" });
      expect(text).toMatch(/^osnova generation [a-f0-9]{16}\nosnova unreferenced: scope src, kinds class,function,method, 2 candidates listed of 2, /);
      expect(text).toContain("- function src/lonely.ts#silent src/lonely.ts:3: 0 unresolved same-name sites, 0 test sites, 0 text mentions in non-test files");
      expect(text).toContain("- function src/lonely.ts#echo src/lonely.ts:4: 1 unresolved same-name sites, 0 test sites, 1 text mentions in non-test files");
      expect(text).not.toContain("#quiet");
      expect(text).toContain("Candidates only: no indexed caller is not proof of no caller.");
      const exported = await callTool(client, "osnova_unreferenced", { scope: "src/lonely", includeExported: true, kinds: ["function"], limit: 1 });
      expect(exported).toContain("1 candidates listed of 3");
      expect(exported).toContain("- function src/lonely.ts#lonely src/lonely.ts:1 (exported):");
      expect(await callTool(client, "osnova_unreferenced", { scope: "src/" })).toBe(text);
      for (const args of [{ limit: "2" }, { kinds: ["nope"] }, { includeExported: "yes" }, { scope: 3 }]) {
        const rejected = await client.callTool({ name: "osnova_unreferenced", arguments: args });
        expect(rejected.isError, JSON.stringify(args)).toBe(true);
      }
    } finally {
      await client.close();
      fs.rmSync(path.join(workspace, "src/lonely.ts"), { force: true });
      fs.rmSync(path.join(workspace, "src/caller.ts"), { force: true });
    }
  }, 60_000);

  it("returns isError for tool failures without crashing the server", async () => {
    const client = await connect();
    try {
      const result = await client.callTool({ name: "osnova_outline", arguments: { file: "missing.ts" } });
      expect(result.isError).toBe(true);
      for (const inherited of ["toString", "constructor", "__proto__"]) {
        const odd = await client.callTool({ name: inherited, arguments: {} });
        expect(odd.isError, inherited).toBe(true);
        const oddContent = (odd as { content?: readonly ContentBlock[] }).content ?? [];
        const oddText = oddContent.map((c) => (c.type === "text" ? c.text : "")).join("");
        expect(oddText, inherited).toBe(`osnova error: unknown tool ${JSON.stringify(inherited)}`);
      }
      const content = (result as { content?: readonly ContentBlock[] }).content ?? [];
      const text = content.map((c) => (c.type === "text" ? c.text : "")).join("");
      expect(text).toContain("osnova error");
      const still = await client.listTools();
      expect(still.tools).toHaveLength(10);
    } finally {
      await client.close();
    }
  }, 60_000);

  it("bounds large skeleton responses with explicit omissions", async () => {
    write("src/large.ts", Array.from({ length: 150 }, (_, index) => `export function ordinaryFunction${index}(value: string): string { return value; }`).join("\n"));
    const client = await connect();
    try {
      const text = await callTool(client, "osnova_outline", { file: "src/large.ts" });
      expect(text.length).toBeLessThanOrEqual(4_096);
      expect(text).toMatch(/omitted: \d+ of 150 signatures/);
      expect(text).toContain("Use skeleton API for the complete file");
    } finally {
      await client.close();
    }
  }, 60_000);

  it("bounds large caller responses with relationship omission counts", async () => {
    write("src/caller-target.ts", "export function callerTarget(): number { return 1; }\n");
    for (let index = 0; index < 100; index += 1) {
      write(`src/caller-${index}.ts`, `import { callerTarget } from "./caller-target.js";\nexport function caller${index}(): number { return callerTarget(); }\n`);
    }
    const client = await connect();
    try {
      const text = await callTool(client, "osnova_warp", { symbol: "src/caller-target.ts#callerTarget" });
      expect(text.length).toBeLessThanOrEqual(2_048);
      expect(text).toMatch(/omitted: \d+ of 100 confirmed edges/);
      expect(text).toContain("Use callersDetailed API for complete structured results");
      expect(text).not.toContain("[output truncated:");
      const full = await callTool(client, "osnova_warp", { symbol: "src/caller-target.ts#callerTarget", full: true });
      expect(full.length).toBeGreaterThan(2_048);
      expect(full.length).toBeLessThanOrEqual(16_384);
      expect(full).toContain("src/caller-99.ts#caller99:2 [import-binding]");
      expect(full).not.toContain("omitted:");
      expect(full).not.toContain("summary:");
    } finally {
      await client.close();
    }
  }, 60_000);

  it("bounds map output while preserving dropped-detail counts", async () => {
    const client = await connect();
    try {
      const text = await callTool(client, "osnova_groundwork", {});
      expect(text.length).toBeLessThanOrEqual(2_048);
      expect(text).toContain("dropped:");
      expect(text).not.toContain("[output truncated:");
    } finally {
      await client.close();
    }
  }, 60_000);

});

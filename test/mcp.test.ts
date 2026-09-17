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
  it("exposes exactly the seven foundation tools", async () => {
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
      ]);
      const byName = new Map(tools.map((t) => [t.name, t]));
      for (const [name, verb] of [
        ["osnova_ground", "Search:"], ["osnova_thread", "Text search:"], ["osnova_outline", "Outline:"],
        ["osnova_warp", "Call graph:"], ["osnova_groundwork", "Repository map:"],
        ["osnova_footing", "Task context:"], ["osnova_settle", "Change impact:"],
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
      expect(settle).toContain("base-snapshot-is-current-index");
      const bad = await client.callTool({ name: "osnova_settle", arguments: { diff: "not a diff" } });
      expect(bad.isError).toBe(true);
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
      expect(still.tools).toHaveLength(7);
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
      expect(text).toMatch(/omitted: \d+ of 100 confirmed relationships/);
      expect(text).toContain("Use callersDetailed API for complete structured results");
      expect(text).not.toContain("[output truncated:");
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

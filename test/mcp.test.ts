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
  it("exposes exactly the five osnova tools", async () => {
    const client = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "osnova_ask",
        "osnova_callers",
        "osnova_find_text",
        "osnova_map",
        "osnova_skeleton",
      ]);
    } finally {
      await client.close();
    }
  });

  it("builds on first use and answers every tool round-trip", async () => {
    write("src/greet.ts", 'import { shout } from "./loud.js";\nexport function greet(name: string): string { return shout(`hello ${name}`); }\n');
    write("src/loud.ts", "export function shout(text: string): string { return text.toUpperCase(); }\n");

    const client = await connect();
    try {
      const askText = await callTool(client, "osnova_ask", { question: "greet name hello" });
      expect(askText).toContain("src/greet.ts");

      const findText = await callTool(client, "osnova_find_text", { pattern: "toUpperCase", fixed: true });
      expect(findText).toContain("src/loud.ts");

      const skeleton = await callTool(client, "osnova_skeleton", { file: "src/greet.ts" });
      expect(skeleton).toContain("function greet");

      const callers = await callTool(client, "osnova_callers", { symbol: "src/loud.ts#shout" });
      expect(callers).toContain("src/greet.ts#greet");

      const mapCard = await callTool(client, "osnova_map", {});
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
      const before = await callTool(client, "osnova_skeleton", { file: "src/greet.ts" });
      expect(before).not.toContain("farewell");

      write("src/greet.ts", 'import { shout } from "./loud.js";\nexport function farewell(): string { return shout("bye"); }\n');

      const after = await callTool(client, "osnova_skeleton", { file: "src/greet.ts" });
      const beforeGeneration = before.match(/generation ([a-f0-9]{64})/)?.[1];
      const afterGeneration = after.match(/generation ([a-f0-9]{64})/)?.[1];
      expect(beforeGeneration).toBeDefined();
      expect(afterGeneration).toBeDefined();
      expect(afterGeneration).not.toBe(beforeGeneration);
      expect(after).toContain("farewell");
      expect(after).not.toContain("function greet");
    } finally {
      await client.close();
    }
  }, 60_000);

  it("returns isError for tool failures without crashing the server", async () => {
    const client = await connect();
    try {
      const result = await client.callTool({ name: "osnova_skeleton", arguments: { file: "missing.ts" } });
      expect(result.isError).toBe(true);
      const content = (result as { content?: readonly ContentBlock[] }).content ?? [];
      const text = content.map((c) => (c.type === "text" ? c.text : "")).join("");
      expect(text).toContain("osnova error");
      const still = await client.listTools();
      expect(still.tools).toHaveLength(5);
    } finally {
      await client.close();
    }
  }, 60_000);
});

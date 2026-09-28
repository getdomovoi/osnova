import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";

const closers: Array<() => void> = [];
const temporaries: string[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const dir of temporaries.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function serve(prewarm: boolean) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-mcp-prewarm-"));
  temporaries.push(temporary);
  const workspace = path.join(temporary, "ws");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "a.ts"), "export function first() { return second(); }\n");
  await fs.writeFile(path.join(workspace, "b.ts"), "import { first } from './a';\nexport function second() { return 2; }\nexport function third() { return first(); }\n");
  const built = createOsnovaMcpServer(workspace, { cacheDir: path.join(temporary, "cache"), prewarm });
  closers.push(built.close);
  const client = new Client({ name: "t", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const result = await client.callTool({ name, arguments: args });
    return ((result as { content?: readonly ContentBlock[] }).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
  };
  return { ...built, call };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("MCP prewarm", () => {
  it("warms after a refresh and answers exactly as a server that does not warm", async () => {
    const warm = await serve(true);
    const cold = await serve(false);
    await warm.refresh();
    await until(() => warm.status().warm === "warm");
    expect(warm.status().warm).toBe("warm");
    expect(cold.status().warm).toBe("off");
    const strip = (text: string): string => text.replace(/^osnova generation .*$/m, "");
    for (const [name, args] of [["osnova_ground", { question: "second" }], ["osnova_footing", { question: "first" }]] as const) {
      expect(strip(await warm.call(name, args))).toBe(strip(await cold.call(name, args)));
    }
  });
});

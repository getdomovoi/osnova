import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";

const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

async function setup(watch: boolean) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-mcp-watch-"));
  const workspace = path.join(temporary, "ws"); await fs.mkdir(path.join(workspace, "node_modules", "dep"), { recursive: true });
  await fs.writeFile(path.join(workspace, "a.ts"), "export function first() { return 1; }\n");
  const built = createOsnovaMcpServer(workspace, { cacheDir: path.join(temporary, "cache"), watch: watch ? { debounceMs: 50, maxStaleMs: 60_000 } : false });
  closers.push(built.close);
  const client = new Client({ name: "t", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  const ground = async (): Promise<string> => {
    const result = await client.callTool({ name: "osnova_ground", arguments: { question: "first" } });
    return ((result as { content?: readonly ContentBlock[] }).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
  };
  return { workspace, built, ground };
}
const generation = (text: string): string => text.match(/osnova generation ([0-9a-f]+)/)?.[1] ?? "";
const until = async (check: () => boolean, ms = 5000): Promise<void> => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); } };

describe("MCP watch mode", () => {
  it("verifies the tree on every query without a watcher", async () => {
    const { built, ground } = await setup(false);
    await ground(); await ground();
    expect(built.status()).toMatchObject({ watching: false, refreshes: 2 });
  });

  it.skipIf(process.platform === "linux" && !process.versions.node.startsWith("2"))("reuses the verified index until a change arrives, then refreshes on its own", async () => {
    const { workspace, built, ground } = await setup(true);
    await new Promise((r) => setTimeout(r, 300));
    await ground();
    const settled = built.status().refreshes;
    const before = generation(await ground());
    await ground();
    expect(built.status()).toMatchObject({ watching: true, refreshes: settled, pendingChanges: false });
    await fs.writeFile(path.join(workspace, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    await new Promise((r) => setTimeout(r, 200));
    expect(built.status().pendingChanges).toBe(false);
    await fs.writeFile(path.join(workspace, "b.ts"), "export function second() { return 2; }\n");
    await until(() => built.status().refreshes >= settled + 1);
    const after = generation(await ground());
    expect(after).not.toBe(before);
    expect(built.status().refreshes).toBe(settled + 1);
    expect(after.length).toBe(16);
  });
});

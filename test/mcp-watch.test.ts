import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { OsnovaIndex } from "../src/types.js";

const refreshGate = vi.hoisted(() => ({ next: undefined as ((run: () => Promise<OsnovaIndex>) => Promise<OsnovaIndex>) | undefined }));

vi.mock("../src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api.js")>();
  const refreshWorkspace = (...args: Parameters<typeof actual.refreshWorkspace>): Promise<OsnovaIndex> => {
    const gate = refreshGate.next;
    refreshGate.next = undefined;
    const run = (): Promise<OsnovaIndex> => actual.refreshWorkspace(...args);
    return gate === undefined ? run() : gate(run);
  };
  return { ...actual, refreshWorkspace };
});

import { indexGeneration } from "../src/api.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";

const closers: Array<() => void> = [];
afterEach(() => { refreshGate.next = undefined; for (const close of closers.splice(0)) close(); });

async function setup(watch: boolean, debounceMs = 50) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-mcp-watch-"));
  const workspace = path.join(temporary, "ws"); await fs.mkdir(path.join(workspace, "node_modules", "dep"), { recursive: true });
  await fs.writeFile(path.join(workspace, "a.ts"), "export function first() { return 1; }\n");
  const built = createOsnovaMcpServer(workspace, { cacheDir: path.join(temporary, "cache"), watch: watch ? { debounceMs, maxStaleMs: 60_000 } : false });
  closers.push(built.close);
  const client = new Client({ name: "t", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  const ground = async (question = "first"): Promise<string> => {
    const result = await client.callTool({ name: "osnova_ground", arguments: { question } });
    return ((result as { content?: readonly ContentBlock[] }).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
  };
  return { workspace, built, ground };
}
const generation = (text: string): string => text.match(/osnova generation ([0-9a-f]+)/)?.[1] ?? "";
const until = async (check: () => boolean, ms = 5000): Promise<void> => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); } };
const recursiveWatch = !(process.platform === "linux" && Number(process.versions.node.split(".")[0]) < 20);

describe("MCP watch mode", () => {
  it("verifies the tree on every query without a watcher", async () => {
    const { built, ground } = await setup(false);
    await ground(); await ground();
    expect(built.status()).toMatchObject({ watching: false, refreshes: 2 });
  });

  it.skipIf(!recursiveWatch)("reuses the verified index until a change arrives, then refreshes on its own", async () => {
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
    expect(after.length).toBe(16);
    await until(() => !built.status().pendingChanges);
    const settledAgain = built.status();
    expect(settledAgain.refreshes).toBeGreaterThanOrEqual(settled + 1);
    expect(settledAgain.pendingChanges).toBe(false);
    expect(indexGeneration(await built.refresh()).slice(0, 16)).toBe(after);
  });

  it.skipIf(!recursiveWatch)("keeps a change pending when its refresh fails instead of answering from the pre-edit index", async () => {
    const { workspace, built, ground } = await setup(true, 60_000);
    await new Promise((r) => setTimeout(r, 300));
    await ground(); await ground();
    expect(built.status().pendingChanges).toBe(false);
    await fs.writeFile(path.join(workspace, "a.ts"), "export function renamed() { return 2; }\n");
    await until(() => built.status().pendingChanges);
    await new Promise((r) => setTimeout(r, 300));
    refreshGate.next = () => Promise.reject(new Error("osnova: injected refresh failure"));
    await expect(built.refresh()).rejects.toThrow("injected refresh failure");
    const pendingAfterFailure = built.status().pendingChanges;
    const servesRenamed = (await ground("renamed")).includes("function renamed");
    const servesDeleted = (await ground("first")).includes("function first");
    expect({ pendingAfterFailure, servesRenamed, servesDeleted }).toEqual({ pendingAfterFailure: true, servesRenamed: true, servesDeleted: false });
    expect(built.status().pendingChanges).toBe(false);
  });

  it.skipIf(!recursiveWatch)("keeps a change that lands during a refresh pending after that refresh succeeds", async () => {
    const { workspace, built, ground } = await setup(true, 60_000);
    await new Promise((r) => setTimeout(r, 300));
    await ground(); await ground();
    expect(built.status().pendingChanges).toBe(false);
    refreshGate.next = async (run) => {
      const index = await run();
      await fs.writeFile(path.join(workspace, "b.ts"), "export function second() { return 2; }\n");
      await until(() => built.status().pendingChanges);
      return index;
    };
    const verified = await built.refresh();
    expect(verified.files.has("b.ts")).toBe(false);
    const pendingAfterRefresh = built.status().pendingChanges;
    const servesSecond = (await ground("second")).includes("function second");
    expect({ pendingAfterRefresh, servesSecond }).toEqual({ pendingAfterRefresh: true, servesSecond: true });
  });
});

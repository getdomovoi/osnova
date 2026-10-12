import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { WitnessedIndex } from "../src/api.js";

const refreshGate = vi.hoisted(() => ({ next: undefined as ((run: () => Promise<WitnessedIndex>) => Promise<WitnessedIndex>) | undefined, rebuilds: 0 }));

vi.mock("../src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api.js")>();
  const refreshWorkspaceWitnessed = (...args: Parameters<typeof actual.refreshWorkspaceWitnessed>): Promise<WitnessedIndex> => {
    if (args[1]?.rebuild === true) refreshGate.rebuilds += 1;
    const gate = refreshGate.next;
    refreshGate.next = undefined;
    const run = (): Promise<WitnessedIndex> => actual.refreshWorkspaceWitnessed(...args);
    return gate === undefined ? run() : gate(run);
  };
  return { ...actual, refreshWorkspaceWitnessed };
});

import { indexGeneration, refreshWorkspace } from "../src/api.js";
import { workspaceDirFor } from "../src/cache/cache.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";

const closers: Array<() => void> = [];
afterEach(() => { refreshGate.next = undefined; for (const close of closers.splice(0)) close(); });

async function serve(workspace: string, cacheDir: string, watch: boolean, debounceMs = 50) {
  const built = createOsnovaMcpServer(workspace, { cacheDir, watch: watch ? { debounceMs, maxStaleMs: 60_000 } : false });
  closers.push(built.close);
  const client = new Client({ name: "t", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  const ground = async (question = "first"): Promise<string> => {
    const result = await client.callTool({ name: "osnova_ground", arguments: { question } });
    return ((result as { content?: readonly ContentBlock[] }).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
  };
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const result = await client.callTool({ name, arguments: args });
    return ((result as { content?: readonly ContentBlock[] }).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
  };
  return { built, ground, call };
}

async function setup(watch: boolean, debounceMs = 50) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-mcp-watch-"));
  const workspace = path.join(temporary, "ws"); await fs.mkdir(path.join(workspace, "node_modules", "dep"), { recursive: true });
  await fs.writeFile(path.join(workspace, "a.ts"), "export function first() { return 1; }\n");
  return { temporary, workspace, ...await serve(workspace, path.join(temporary, "cache"), watch, debounceMs) };
}
const generation = (text: string): string => text.match(/osnova generation ([0-9a-f]+)/)?.[1] ?? "";
const until = async (check: () => boolean, ms = 5000): Promise<void> => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); } };
const recursiveWatch = !(process.platform === "linux" && Number(process.versions.node.split(".")[0]) < 20);

describe("MCP watch mode", () => {
  it("reuses the verified index without a watcher while the tree's metadata is unchanged", async () => {
    const { workspace, built, ground } = await setup(false);
    const answers = [await ground(), await ground(), await ground()];
    await fs.writeFile(path.join(workspace, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    answers.push(await ground());
    expect(built.status()).toMatchObject({ watching: false, refreshes: 1, pendingChanges: false });
    expect(new Set(answers).size).toBe(1);
  });

  it("refreshes before answering without a watcher when a file, a directory or an ignore file changes", async () => {
    const { temporary, workspace, built, ground } = await setup(false);
    await fs.writeFile(path.join(workspace, ".gitignore"), "# none yet\n");
    await fs.mkdir(path.join(workspace, "src"));
    await ground();
    const refreshes = (): number => built.status().refreshes;
    expect(refreshes()).toBe(1);

    await fs.writeFile(path.join(workspace, "a.ts"), "export function renamed() { return 2; }\n");
    expect(await ground("renamed")).toContain("function renamed");
    expect(refreshes()).toBe(2);

    await fs.writeFile(path.join(workspace, "src", "b.ts"), "export function second() { return 2; }\n");
    expect(await ground("second")).toContain("function second");
    expect(refreshes()).toBe(3);

    await fs.mkdir(path.join(workspace, "src", "deep"));
    await fs.writeFile(path.join(workspace, "src", "deep", "c.ts"), "export function third() { return 3; }\n");
    expect(await ground("third")).toContain("function third");
    expect(refreshes()).toBe(4);

    await fs.appendFile(path.join(workspace, ".gitignore"), "src/deep/\n");
    expect(await ground("third")).not.toContain("function third");
    expect(refreshes()).toBe(5);

    await fs.rm(path.join(workspace, "a.ts"));
    const reused = await ground("renamed");
    expect(reused).not.toContain("function renamed");
    expect(refreshes()).toBe(6);
    expect(await ground("renamed")).toBe(reused);
    expect(refreshes()).toBe(6);

    const fresh = await serve(workspace, path.join(temporary, "fresh-cache"), false);
    expect(await fresh.ground("renamed")).toBe(reused);
  });

  describe.each([
    ["deleted", (file: string) => fs.rm(file)],
    ["truncated", (file: string) => fs.truncate(file, 3)],
    ["replaced with other bytes", async (file: string) => fs.writeFile(file, "x".repeat((await fs.stat(file)).size + 7))],
    ["overwritten in place at the same size", async (file: string) => fs.writeFile(file, "x".repeat((await fs.stat(file)).size))],
  ])("without a watcher, when the loaded cache's text sidecar is %s", (_label, damage) => {
    it("repairs the cache before a text query instead of failing on the kept index", async () => {
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-mcp-text-"));
      const workspace = path.join(temporary, "ws"); await fs.mkdir(workspace);
      await fs.writeFile(path.join(workspace, "a.ts"), "export function first() { return 1; }\n");
      const cacheDir = path.join(temporary, "cache");
      await refreshWorkspace(workspace, { cacheDir });
      const { built, call } = await serve(workspace, cacheDir, false);
      expect(await call("osnova_outline", { file: "a.ts" })).toContain("first");
      expect(built.status().refreshes).toBe(1);

      await damage(path.join(workspaceDirFor(await fs.realpath(cacheDir), await fs.realpath(workspace)), "text.bin"));
      const thread = { pattern: "return 1", fixed: true };
      const answer = await call("osnova_thread", thread);
      const expected = await (await serve(workspace, path.join(temporary, "fresh-cache"), false)).call("osnova_thread", thread);
      expect(answer).not.toContain("cache-read-failed");
      expect(answer).toBe(expected);
      expect(await call("osnova_thread", thread)).toBe(expected);
      expect(built.status().refreshes).toBe(2);
    });

    it("rebuilds once for simultaneous text queries that fail on the same kept index", async () => {
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-mcp-text-"));
      const workspace = path.join(temporary, "ws"); await fs.mkdir(workspace);
      await fs.writeFile(path.join(workspace, "a.ts"), "export function first() { return 1; }\n");
      const cacheDir = path.join(temporary, "cache");
      await refreshWorkspace(workspace, { cacheDir });
      const { built, call } = await serve(workspace, cacheDir, false);
      expect(await call("osnova_outline", { file: "a.ts" })).toContain("first");

      await damage(path.join(workspaceDirFor(await fs.realpath(cacheDir), await fs.realpath(workspace)), "text.bin"));
      const thread = { pattern: "return 1", fixed: true };
      refreshGate.rebuilds = 0;
      const answers = await Promise.all([1, 2, 3, 4].map(() => call("osnova_thread", thread)));
      const expected = await (await serve(workspace, path.join(temporary, "fresh-cache"), false)).call("osnova_thread", thread);
      expect(refreshGate.rebuilds).toBe(1);
      expect(built.status().refreshes).toBe(2);
      expect(answers).toEqual([expected, expected, expected, expected]);
      expect(await call("osnova_thread", thread)).toBe(expected);
      expect(built.status().refreshes).toBe(2);
    });
  });

  it("reports a text sidecar read failure that rebuilding cannot repair instead of rebuilding", async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-mcp-text-"));
    const workspace = path.join(temporary, "ws"); await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "a.ts"), "export function first() { return 1; }\n");
    const cacheDir = path.join(temporary, "cache");
    await refreshWorkspace(workspace, { cacheDir });
    const { built, call } = await serve(workspace, cacheDir, false);
    expect(await call("osnova_outline", { file: "a.ts" })).toContain("first");
    const text = path.join(workspaceDirFor(await fs.realpath(cacheDir), await fs.realpath(workspace)), "text.bin");
    await fs.rm(text);
    await fs.mkdir(text);
    expect(await call("osnova_thread", { pattern: "return 1", fixed: true })).toContain("cache-read-failed");
    expect(built.status().refreshes).toBe(1);
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

import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { workspaceLockPath } from "../src/cache/cache.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";

// A watcher may report a change made before it started, as macOS reports a file written just before: the event names
// a file whose content and metadata the server's first scan already read. Each test here sends such an event to the
// server's watcher at a chosen moment, besides the events the platform sends.
const watchers = vi.hoisted(() => ({ listeners: [] as Array<(event: string, file: string | null) => void> }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const watch = ((target: string, options: unknown, listener: (event: string, file: string | null) => void) => {
    watchers.listeners.push(listener);
    return actual.watch(target, options as never, listener as never);
  }) as typeof actual.watch;
  return { ...actual, default: { ...actual, watch }, watch };
});

const replay = (file: string | null = "a.ts"): void => { for (const listener of watchers.listeners) listener("change", file); };

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  watchers.listeners.length = 0;
  for (const close of closers.splice(0).reverse()) await close();
});

type Moment = "before the first scan" | "after the first scan" | "after the first query";

async function setup(moment: Moment) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "osnova-mcp-replay-")));
  closers.push(() => fs.rm(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, "ws");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "a.ts"), "export function first() { return 1; }\n");
  const cacheDir = path.join(temporary, "cache");
  const lockPath = workspaceLockPath(cacheDir, workspace);
  // The workspace lock is staged and renamed into place before the scan; the artifact is published after it.
  const ofLock = (target: unknown): boolean => path.basename(String(target)).startsWith(path.basename(lockPath));
  const mkdir = fs.mkdir.bind(fs) as (...args: unknown[]) => Promise<unknown>;
  const rename = fs.rename.bind(fs) as (...args: unknown[]) => Promise<unknown>;
  let pending = moment !== "after the first query";
  vi.spyOn(fs, "mkdir").mockImplementation((async (...args: unknown[]) => {
    if (pending && moment === "before the first scan" && ofLock(args[0])) {
      pending = false;
      replay();
    }
    return await mkdir(...args);
  }) as never);
  vi.spyOn(fs, "rename").mockImplementation((async (...args: unknown[]) => {
    const result = await rename(...args);
    if (pending && moment === "after the first scan" && !ofLock(args[0])) {
      pending = false;
      replay();
    }
    return result;
  }) as never);
  const built = createOsnovaMcpServer(workspace, { cacheDir, watch: { debounceMs: 50, maxStaleMs: 60_000 }, refreshLockTimeoutMs: 250 });
  closers.push(built.close);
  const client = new Client({ name: "t", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  const ground = async (question = "first"): Promise<{ text: string; isError: boolean }> => {
    const result = await client.callTool({ name: "osnova_ground", arguments: { question } }) as { content?: readonly ContentBlock[]; isError?: boolean };
    return { text: (result.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""), isError: result.isError === true };
  };
  const warmed = await ground();
  expect(warmed.isError).toBe(false);
  expect(warmed.text).toContain("first");
  expect(pending).toBe(false);
  vi.restoreAllMocks();
  if (moment === "after the first query") replay();
  return { built, ground, workspace, lockPath };
}

const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 300)); };

describe.each<Moment>(["before the first scan", "after the first scan", "after the first query"])("an MCP watcher that reports a change already read %s", (moment) => {
  it("reuses the warm index without another refresh", async () => {
    const { built, ground } = await setup(moment);
    const answered = await ground();
    expect(answered.isError).toBe(false);
    expect(answered.text).toContain("first");
    expect(built.status().refreshes).toBe(1);
    await settle();
    expect((await ground()).isError).toBe(false);
    expect(built.status()).toMatchObject({ refreshes: 1, pendingChanges: false });
  });

  it("settles the reported change without another refresh", async () => {
    const { built } = await setup(moment);
    await settle();
    expect(built.status()).toMatchObject({ refreshes: 1, pendingChanges: false });
  });

  it("still refreshes for a change the watcher reports after it", async () => {
    const { built, ground, workspace } = await setup(moment);
    await fs.writeFile(path.join(workspace, "a.ts"), "export function first() { return 1; }\nexport function secondHelper() { return 2; }\n");
    replay();
    const answered = await ground("secondHelper");
    expect(answered.isError).toBe(false);
    expect(answered.text).toContain("secondHelper");
    expect(built.status().refreshes).toBe(2);
  });

  it("still refreshes for a new file the watcher reports by its directory alone", async () => {
    const { built, ground, workspace } = await setup(moment);
    await fs.writeFile(path.join(workspace, "b.ts"), "export function thirdHelper() { return 3; }\n");
    replay(null);
    const answered = await ground("thirdHelper");
    expect(answered.isError).toBe(false);
    expect(answered.text).toContain("thirdHelper");
    expect(built.status().refreshes).toBe(2);
  });
});

describe.each<Moment>(["before the first scan", "after the first scan"])("an MCP watcher that reports a change already read %s, with the workspace lock in play", (moment) => {
  it("fails closed with no further refresh once the workspace lock is contended", async () => {
    const { built, ground, lockPath } = await setup(moment);
    await settle();
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, "owner.json"), "not an owner");
    const contended = await ground();
    expect(contended.isError).toBe(true);
    expect(contended.text).toMatch(/lock/);
    expect(built.status().refreshes).toBe(1);
  });

  it("does not reuse the index once the watcher reports a change made while the lock was probed", async () => {
    const { built, ground, lockPath, workspace } = await setup(moment);
    expect(built.status().pendingChanges).toBe(false);
    const lstat = fs.lstat.bind(fs);
    let probed = false;
    vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
      if (!probed && path.resolve(String(target)) === lockPath) {
        probed = true;
        await fs.writeFile(path.join(workspace, "a.ts"), "export function first() { return 1; }\nexport function secondHelper() { return 2; }\n");
        replay();
      }
      return await lstat(target, options as never) as never;
    });
    const answered = await ground("secondHelper");
    expect(probed).toBe(true);
    expect(answered.isError).toBe(false);
    expect(answered.text).toContain("secondHelper");
  });
});

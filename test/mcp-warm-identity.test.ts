import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { workspaceLockPath } from "../src/cache/cache.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";

const watchers = vi.hoisted(() => [] as FSWatcher[]);
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  const watch = (...args: Parameters<typeof original.watch>): FSWatcher => {
    const watcher = original.watch(...args);
    watchers.push(watcher);
    return watcher;
  };
  return { ...original, default: { ...original, watch }, watch };
});

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  watchers.splice(0);
  for (const close of closers.splice(0).reverse()) await close();
});

const watch = { debounceMs: 60_000, maxStaleMs: 60_000 };
const first = "export function first() { return 1; }\n";
const second = "export function first() { return 1; }\nexport function secondHelper() { return 2; }\n";
const retargeted = "export function first() { return 1; }\nexport function retargetedHelper() { return 3; }\n";

// The workspace is a symlink to one of two roots, so a test can retarget it to the other.
async function setup(serverOptions: { watch?: { debounceMs: number; maxStaleMs: number } | false } = {}) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "osnova-mcp-identity-")));
  closers.push(() => fs.rm(temporary, { recursive: true, force: true }));
  const rootA = path.join(temporary, "a");
  const rootB = path.join(temporary, "b");
  await fs.mkdir(rootA);
  await fs.mkdir(rootB);
  await fs.writeFile(path.join(rootA, "a.ts"), first);
  await fs.writeFile(path.join(rootB, "a.ts"), retargeted);
  const workspace = path.join(temporary, "ws");
  await fs.symlink(rootA, workspace, "dir");
  const cacheDir = path.join(temporary, "cache");
  const built = createOsnovaMcpServer(workspace, { cacheDir, watch: serverOptions.watch ?? false, refreshLockTimeoutMs: 250 });
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
  expect(built.status().refreshes).toBe(1);
  const canonicalCache = await fs.realpath(cacheDir);
  const pointAt = async (root: string): Promise<void> => {
    const next = path.join(temporary, "ws-next");
    await fs.symlink(root, next, "dir");
    await fs.rename(next, workspace);
  };
  const retarget = (): Promise<void> => pointAt(rootB);
  const restore = (): Promise<void> => pointAt(rootA);
  return { built, ground, workspace, rootA, rootB, retarget, restore, lockA: workspaceLockPath(canonicalCache, rootA), lockB: workspaceLockPath(canonicalCache, rootB) };
}

// Runs once, during the first call of the named promise-API method on the given path, or on any path when none is
// given, then lets the call proceed. Resolves once that call has settled.
function during(method: "lstat" | "realpath", target: string | undefined, interlude: () => Promise<void>): Promise<void> {
  const original = fs[method].bind(fs) as (...args: unknown[]) => Promise<unknown>;
  let pending = true;
  return new Promise((resolve) => {
    vi.spyOn(fs, method).mockImplementation((async (...args: unknown[]) => {
      if (!pending || (target !== undefined && path.resolve(String(args[0])) !== target)) return await original(...args);
      pending = false;
      await interlude();
      try {
        return await original(...args);
      } finally {
        resolve();
      }
    }) as never);
  });
}

// Runs once, after the first call of the named promise-API method on the given path has settled, then hands the
// caller that call's result.
function after(method: "lstat", target: string, interlude: () => Promise<void>): void {
  const original = fs[method].bind(fs) as (...args: unknown[]) => Promise<unknown>;
  let pending = true;
  vi.spyOn(fs, method).mockImplementation((async (...args: unknown[]) => {
    if (!pending || path.resolve(String(args[0])) !== target) return await original(...args);
    pending = false;
    const settled = await original(...args).then((value) => ({ value }), (error: unknown) => ({ error }));
    await interlude();
    if ("error" in settled) throw settled.error;
    return settled.value;
  }) as never);
}

// Resolves when the named promise-API method is first called with the given path as the argument at that position.
function reached(method: "rename", target: string, position: number): Promise<void> {
  const original = fs[method].bind(fs) as (...args: unknown[]) => Promise<unknown>;
  return new Promise((resolve) => {
    vi.spyOn(fs, method).mockImplementation((async (...args: unknown[]) => {
      if (path.resolve(String(args[position])) === target) resolve();
      return await original(...args);
    }) as never);
  });
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function liveChild(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  closers.push(() => { child.kill(); });
  return child;
}

async function plantLiveLock(lockPath: string): Promise<void> {
  await fs.mkdir(lockPath);
  await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: liveChild().pid!, host: os.hostname(), token: randomUUID() }));
}

function stopWatcher(): void {
  expect(watchers).toHaveLength(1);
  watchers[0]!.emit("error", new Error("watcher failed in test"));
}

describe("warm reuse and the workspace root", () => {
  it.each([
    ["with a watcher", watch],
    ["without a watcher", false as const],
  ])("does not answer from the old root's index when the workspace is retargeted during the lock probe, %s", async (_label, mode) => {
    const { built, ground, retarget, lockA } = await setup({ watch: mode });
    during("lstat", lockA, retarget);
    const answered = await ground("retargetedHelper");
    expect(answered.isError).toBe(false);
    expect(answered.text).toContain("retargetedHelper");
    expect(built.status().refreshes).toBe(2);
  });

  it("does not bypass a contended old-root lock when the workspace is retargeted as the probe resolves the root", async () => {
    const { ground, workspace, retarget, lockA } = await setup({ watch });
    await plantLiveLock(lockA);
    during("realpath", workspace, retarget);
    const answered = await ground("retargetedHelper");
    expect(answered.isError).toBe(false);
    expect(answered.text).toContain("retargetedHelper");
  });

  // The refresh the contended lock sends the query to resolves the workspace while it names the other root, so it
  // answers from that root; reuse would have answered from the kept index of the root whose lock is held.
  it("does not reuse the kept index under its root's contended lock when the workspace is retargeted away and back during the probe", async () => {
    const { built, ground, workspace, retarget, restore, lockA, lockB } = await setup({ watch });
    await plantLiveLock(lockA);
    during("realpath", workspace, retarget);
    during("lstat", lockB, restore);
    const answered = await ground("retargetedHelper");
    expect(answered.isError).toBe(false);
    expect(answered.text).toContain("retargetedHelper");
    expect(built.status().refreshes).toBe(2);
  });

  it.each([
    ["with a watcher", watch],
    ["without a watcher", false as const],
  ])("does not join a refresh of the old root that is still pending when the workspace is retargeted, %s", async (_label, mode) => {
    const { built, ground, retarget, lockA } = await setup({ watch: mode });
    await plantLiveLock(lockA);
    const waiting = reached("rename", lockA, 1);
    const pending = built.refresh().then(() => "answered", () => "failed");
    await waiting;
    await retarget();
    const answered = await ground("retargetedHelper");
    expect(answered.isError).toBe(false);
    expect(answered.text).toContain("retargetedHelper");
    expect(await pending).toBe("failed");
  });

  // The pending refresh resolved the workspace while it named the other root, so it waits on that root's held lock;
  // a query that resolves the first root again must not wait on it.
  it("does not join a pending refresh of the other root when the workspace is retargeted away and back as it starts", async () => {
    const { built, ground, retarget, restore, lockA } = await setup();
    await retarget();
    await plantLiveLock(lockA);
    const resolved = during("realpath", undefined, restore);
    const pending = built.refresh().then(() => "answered", () => "failed");
    await resolved;
    await retarget();
    const answered = await ground("retargetedHelper");
    expect(answered.isError).toBe(false);
    expect(answered.text).toContain("retargetedHelper");
    expect(await pending).toBe("failed");
  });

  it("does not take a watcher on the old root as evidence for the new root", async () => {
    const { built, ground, retarget, rootB } = await setup({ watch });
    await retarget();
    expect((await ground("retargetedHelper")).text).toContain("retargetedHelper");
    expect(built.status().refreshes).toBe(2);
    await fs.writeFile(path.join(rootB, "a.ts"), `${retargeted}export function laterHelper() { return 4; }\n`);
    const answered = await ground("laterHelper");
    expect(answered.isError).toBe(false);
    expect(answered.text).toContain("laterHelper");
  });
});

describe("warm reuse and the watcher", () => {
  it("does not answer from the pre-edit index when a change is seen and the watcher stops during the lock probe", async () => {
    const { built, ground, rootA, lockA } = await setup({ watch });
    during("lstat", lockA, async () => {
      await fs.writeFile(path.join(rootA, "a.ts"), second);
      await until(() => built.status().pendingChanges);
      stopWatcher();
    });
    const answered = await ground("secondHelper");
    expect(built.status().watching).toBe(false);
    expect(answered.isError).toBe(false);
    expect(answered.text).toContain("secondHelper");
  });

  it("verifies the tree when the watcher stops during the lock probe before an edit it never sees", async () => {
    const { built, ground, rootA, lockA } = await setup({ watch });
    during("lstat", lockA, async () => {
      stopWatcher();
      await fs.writeFile(path.join(rootA, "a.ts"), second);
    });
    const answered = await ground("secondHelper");
    expect(built.status().watching).toBe(false);
    expect(answered.isError).toBe(false);
    expect(answered.text).toContain("secondHelper");
  });

  it("does not keep a watcher as evidence once its directory is replaced at the same path", async () => {
    const { ground, rootA } = await setup({ watch });
    await fs.rename(rootA, `${rootA}-replaced`);
    await fs.mkdir(rootA);
    await fs.writeFile(path.join(rootA, "a.ts"), second);
    expect((await ground("secondHelper")).text).toContain("secondHelper");
    await fs.writeFile(path.join(rootA, "a.ts"), `${second}export function laterHelper() { return 4; }\n`);
    const answered = await ground("laterHelper");
    expect(answered.isError).toBe(false);
    expect(answered.text).toContain("laterHelper");
  });

  it("keeps the metadata-only reuse while the watcher is healthy and the root unchanged", async () => {
    const { built, ground } = await setup({ watch });
    for (let query = 0; query < 3; query += 1) expect((await ground()).isError).toBe(false);
    expect(built.status()).toMatchObject({ watching: true, refreshes: 1, pendingChanges: false });
  });
});

describe("warm reuse and the workspace lock", () => {
  it.each([
    ["with a watcher", watch],
    ["without a watcher", false as const],
  ])("does not answer from the kept index when another owner takes the lock after the probe found it free, %s", async (_label, mode) => {
    const { built, ground, lockA } = await setup({ watch: mode });
    after("lstat", lockA, () => plantLiveLock(lockA));
    const answered = await ground();
    expect(answered.isError).toBe(true);
    expect(answered.text).toMatch(/lock/);
    expect(built.status().refreshes).toBe(1);
  });
});

describe("warm reuse and the index generation", () => {
  it("answers from the index a watched refresh published while the lock was probed", async () => {
    const { built, ground, rootA, lockA } = await setup({ watch: { debounceMs: 20, maxStaleMs: 60_000 } });
    during("lstat", lockA, async () => {
      await fs.writeFile(path.join(rootA, "a.ts"), second);
      await until(() => built.status().refreshes === 2 && !built.status().pendingChanges);
    });
    const answered = await ground("secondHelper");
    expect(answered.isError).toBe(false);
    expect(answered.text).toContain("secondHelper");
    expect(built.status().refreshes).toBe(2);
  });

  it("verifies under the lock again when it contends after a watched refresh replaced the index", async () => {
    const { built, ground, rootA, lockA } = await setup({ watch: { debounceMs: 20, maxStaleMs: 60_000 } });
    during("lstat", lockA, async () => {
      await fs.writeFile(path.join(rootA, "a.ts"), second);
      await until(() => built.status().refreshes === 2 && !built.status().pendingChanges);
      await plantLiveLock(lockA);
    });
    const contended = await ground();
    expect(contended.isError).toBe(true);
    expect(contended.text).toMatch(/lock/);
    await fs.rm(lockA, { recursive: true, force: true });
    expect((await ground("secondHelper")).text).toContain("secondHelper");
    expect(built.status().refreshes).toBe(3);
  });
});

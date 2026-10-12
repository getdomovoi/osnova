import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { workspaceLockPath } from "../src/cache/cache.js";
import { withCacheLock } from "../src/cache/lock.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function setup(serverOptions: { watch?: boolean | { debounceMs: number; maxStaleMs: number } | undefined; refreshLockTimeoutMs?: number | undefined } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-mcp-lock-"));
  closers.push(() => fs.rm(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, "ws");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "a.ts"), "export function first() { return 1; }\n");
  const cacheDir = path.join(temporary, "cache");
  const built = createOsnovaMcpServer(workspace, { cacheDir, watch: serverOptions.watch ?? false, refreshLockTimeoutMs: serverOptions.refreshLockTimeoutMs ?? 250 });
  closers.push(built.close);
  const client = new Client({ name: "t", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  const ground = async (): Promise<{ text: string; isError: boolean }> => {
    const result = await client.callTool({ name: "osnova_ground", arguments: { question: "first" } }) as { content?: readonly ContentBlock[]; isError?: boolean };
    return { text: (result.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""), isError: result.isError === true };
  };
  const warmed = await ground();
  expect(warmed.isError).toBe(false);
  expect(warmed.text).toContain("first");
  expect(built.status().refreshes).toBe(1);
  expect(built.status().watching).toBe(serverOptions.watch !== undefined && serverOptions.watch !== false);
  const lockPath = workspaceLockPath(await fs.realpath(cacheDir), await fs.realpath(workspace));
  return { built, ground, lockPath };
}

function liveChild(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  closers.push(() => { child.kill(); });
  return child;
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return child.pid!;
}

async function plantLock(lockPath: string, ownerText: string): Promise<void> {
  await fs.mkdir(lockPath);
  await fs.writeFile(path.join(lockPath, "owner.json"), ownerText);
}

const owner = (pid: number): string => JSON.stringify({ pid, host: os.hostname(), token: randomUUID() });

describe("MCP warm queries and the workspace lock", () => {
  it("reuses the warm index while no lock contends", async () => {
    const { built, ground } = await setup();
    expect((await ground()).isError).toBe(false);
    expect(built.status().refreshes).toBe(1);
  });

  it("fails closed when a live foreign owner holds the workspace lock", async () => {
    const { built, ground, lockPath } = await setup();
    await plantLock(lockPath, owner(liveChild().pid!));
    const contended = await ground();
    expect(contended.isError).toBe(true);
    expect(contended.text).toMatch(/lock/);
    expect(built.status().refreshes).toBe(1);
  });

  it("recovers after the fixture lock is released", async () => {
    const { built, ground, lockPath } = await setup();
    const child = liveChild();
    await plantLock(lockPath, owner(child.pid!));
    expect((await ground()).isError).toBe(true);
    child.kill();
    await fs.rm(lockPath, { recursive: true, force: true });
    const recovered = await ground();
    expect(recovered.isError).toBe(false);
    expect(recovered.text).toContain("first");
    expect(built.status().refreshes).toBe(2);
  });

  it("fails closed while an in-process publisher holds the lock", async () => {
    const { built, ground, lockPath } = await setup();
    let acquired!: () => void;
    const holding = new Promise<void>((resolve) => { acquired = resolve; });
    const publisher = withCacheLock(lockPath, async () => {
      acquired();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });
    await holding;
    const contended = await ground();
    expect(contended.isError).toBe(true);
    expect(contended.text).toMatch(/lock/);
    await publisher;
    const recovered = await ground();
    expect(recovered.isError).toBe(false);
    expect(built.status().refreshes).toBe(2);
  });

  it("fails closed when the owner file cannot be parsed", async () => {
    const { built, ground, lockPath } = await setup();
    await plantLock(lockPath, "not an owner");
    const contended = await ground();
    expect(contended.isError).toBe(true);
    expect(contended.text).toMatch(/lock/);
    await fs.rm(lockPath, { recursive: true, force: true });
    expect((await ground()).isError).toBe(false);
    expect(built.status().refreshes).toBe(2);
  });

  it("fails closed when the lock directory holds an unexpected entry", async () => {
    const { ground, lockPath } = await setup();
    await plantLock(lockPath, owner(await exitedPid()));
    await fs.writeFile(path.join(lockPath, "stray"), "");
    const contended = await ground();
    expect(contended.isError).toBe(true);
    expect(contended.text).toMatch(/lock/);
  });

  it("answers through a refresh that reclaims a lock naming only an exited owner", async () => {
    const { built, ground, lockPath } = await setup();
    await plantLock(lockPath, owner(await exitedPid()));
    const answered = await ground();
    expect(answered.isError).toBe(false);
    expect(answered.text).toContain("first");
    expect(built.status().refreshes).toBe(2);
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("MCP warm queries and the workspace lock with a watcher", () => {
  const watch = { debounceMs: 50, maxStaleMs: 60_000 };

  it("reuses the warm index while no lock contends", async () => {
    const { built, ground } = await setup({ watch });
    expect((await ground()).isError).toBe(false);
    expect(built.status().refreshes).toBe(1);
  });

  it("fails closed when a live foreign owner holds the workspace lock", async () => {
    const { built, ground, lockPath } = await setup({ watch });
    await plantLock(lockPath, owner(liveChild().pid!));
    const contended = await ground();
    expect(contended.isError).toBe(true);
    expect(contended.text).toMatch(/lock/);
    expect(built.status().refreshes).toBe(1);
    const again = await ground();
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/lock/);
  });

  it("recovers after the fixture lock is released", async () => {
    const { built, ground, lockPath } = await setup({ watch });
    const child = liveChild();
    await plantLock(lockPath, owner(child.pid!));
    expect((await ground()).isError).toBe(true);
    child.kill();
    await fs.rm(lockPath, { recursive: true, force: true });
    const recovered = await ground();
    expect(recovered.isError).toBe(false);
    expect(recovered.text).toContain("first");
    expect(built.status().refreshes).toBe(2);
    expect((await ground()).isError).toBe(false);
    expect(built.status().refreshes).toBe(2);
  });

  it("fails a contended query only after the refresh lock timeout", async () => {
    const { built, ground, lockPath } = await setup({ watch, refreshLockTimeoutMs: 400 });
    let acquired!: () => void;
    const holding = new Promise<void>((resolve) => { acquired = resolve; });
    const publisher = withCacheLock(lockPath, async () => {
      acquired();
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });
    await holding;
    const started = Date.now();
    const contended = await ground();
    expect(contended.isError).toBe(true);
    expect(contended.text).toMatch(/lock/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(built.status().refreshes).toBe(1);
    await publisher;
    expect((await ground()).isError).toBe(false);
    expect(built.status().refreshes).toBe(2);
  });

  it("answers through a refresh when the contending publisher releases within the timeout", async () => {
    const { built, ground, lockPath } = await setup({ watch, refreshLockTimeoutMs: 5000 });
    let acquired!: () => void;
    const holding = new Promise<void>((resolve) => { acquired = resolve; });
    const publisher = withCacheLock(lockPath, async () => {
      acquired();
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await holding;
    const answered = await ground();
    expect(answered.isError).toBe(false);
    expect(answered.text).toContain("first");
    expect(built.status().refreshes).toBe(2);
    await publisher;
  });
});

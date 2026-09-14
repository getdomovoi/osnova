import { afterEach, expect, it, vi } from "vitest";
import { promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { refreshWorkspace, evidenceFingerprint, indexGeneration, loadIndex } from "../src/api.js";
import { buildIndex } from "../src/index/build.js";
import { serializeArtifact } from "../src/index/serialize.js";
import { workspaceLockPath } from "../src/cache/cache.js";
import { withCacheLock } from "../src/cache/lock.js";

const temporary: string[] = [];
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-workspace-refresh-"));
  temporary.push(dir);
  const root = path.join(dir, "root");
  const cacheDir = path.join(dir, "cache");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
  return { root, cacheDir };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it("single-flights concurrent calls across root aliases and exposes stable evidence identity", async () => {
  const { root, cacheDir } = await fixture();
  const alias = `${root}-alias`;
  await fs.symlink(root, alias, "dir");
  const progress = vi.fn();
  const indexes = await Promise.all(Array.from({ length: 16 }, (_, i) => refreshWorkspace(i % 2 ? root : alias, { cacheDir, onProgress: progress })));
  expect(new Set(indexes).size).toBe(1);
  expect(progress.mock.calls.filter(([event]) => event.phase === "scan")).toHaveLength(1);
  const index = indexes[0]!;
  const original = evidenceFingerprint(index, ["a.ts"]);
  expect(original.sourceHashes["a.ts"]).toBe(index.files.get("a.ts")?.hash);
  expect(indexGeneration((await loadIndex(alias, { cacheDir }))!)).toBe(original.generation);
  await fs.writeFile(path.join(root, "a.ts"), "export const a = 2;\n");
  const updated = await refreshWorkspace(root, { cacheDir });
  expect(indexGeneration(updated)).not.toBe(original.generation);
  expect(serializeArtifact(updated)).toEqual(serializeArtifact(await buildIndex(root, { cacheDir })));
});

it("retains the last coherent artifact when scanning fails, and retries after failure", async () => {
  const { root, cacheDir } = await fixture();
  const initial = await refreshWorkspace(root, { cacheDir });
  await fs.mkdir(path.join(root, ".gitignore"));
  await expect(refreshWorkspace(root, { cacheDir })).rejects.toThrow(/ignore-unreadable/);
  expect(indexGeneration((await loadIndex(root, { cacheDir }))!)).toBe(indexGeneration(initial));
  await fs.rmdir(path.join(root, ".gitignore"));
  await fs.unlink(path.join(root, "a.ts"));
  await fs.writeFile(path.join(root, "b.ts"), "export const b = 1;\n");
  const next = await refreshWorkspace(root, { cacheDir });
  expect([...next.files.keys()]).toEqual(["b.ts"]);
});

it("does not index its cache or runtime lock metadata when cache lives inside the workspace", async () => {
  const { root } = await fixture();
  const cacheDir = path.join(root, "local-cache");
  const first = await refreshWorkspace(root, { cacheDir });
  const next = await refreshWorkspace(root, { cacheDir });
  expect([...first.files.keys()]).toEqual(["a.ts"]);
  expect(indexGeneration(next)).toBe(indexGeneration(first));
  expect(serializeArtifact(await buildIndex(root, { cacheDir }))).toEqual(serializeArtifact(next));
});

it("verifies source hashes before publication and refuses a continuously changing build", async () => {
  const { root, cacheDir } = await fixture();
  const original = await refreshWorkspace(root, { cacheDir });
  let edit = 1;
  await expect(buildIndex(root, { cacheDir, onProgress(event) {
    if (event.phase === "resolve") writeFileSync(path.join(root, "a.ts"), `export const a = ${++edit};\n`);
  } })).rejects.toThrow(/workspace-changing/);
  expect(indexGeneration((await loadIndex(root, { cacheDir }))!)).toBe(indexGeneration(original));
  const updated = await refreshWorkspace(root, { cacheDir });
  expect(updated.files.get("a.ts")?.text).toContain("4");
});

it("times out without stealing an active lock and succeeds after its owner releases", async () => {
  const { root, cacheDir } = await fixture();
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const owner = withCacheLock(workspaceLockPath(cacheDir, root), async () => { acquired(); await gate; });
  try {
    await ready;
    await expect(refreshWorkspace(root, { cacheDir, lockTimeoutMs: 30, lockPollMs: 5 })).rejects.toThrow(/cache-lock-timeout/);
    expect(await fs.readdir(workspaceLockPath(cacheDir, root))).toEqual(["owner.json"]);
  } finally {
    release();
    await owner;
  }
  expect((await refreshWorkspace(root, { cacheDir })).files.size).toBe(1);
});

function childFixture(root: string, cacheDir: string, mode: "refresh" | "hold" | "abandon") {
  const api = new URL("../src/api.ts", import.meta.url).href;
  const cache = new URL("../src/cache/cache.ts", import.meta.url).href;
  const lock = new URL("../src/cache/lock.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { refreshWorkspace, indexGeneration } from ${JSON.stringify(api)};
    import { workspaceLockPath } from ${JSON.stringify(cache)};
    import { withCacheLock } from ${JSON.stringify(lock)};
    const root = ${JSON.stringify(root)}, cacheDir = ${JSON.stringify(cacheDir)};
    let release;
    setTimeout(() => process.exit(3), 8000).unref();
    process.on("message", async (message) => {
      if (message === "stop") { release?.(); process.disconnect(); return; }
      if (message === "release") { release?.(); return; }
      if (message !== "start") return;
      try {
        if (${JSON.stringify(mode)} === "refresh") {
          const index = await refreshWorkspace(root, { cacheDir });
          process.send({ event: "result", generation: indexGeneration(index), paths: [...index.files.keys()] });
        } else {
          await withCacheLock(workspaceLockPath(cacheDir, root), async () => {
            process.send({ event: "acquired" });
            if (${JSON.stringify(mode)} === "abandon") { process.disconnect(); process.exit(0); }
            await new Promise(resolve => { release = resolve; });
          });
          if (process.connected) process.send({ event: "released" });
        }
      } catch (error) { if (process.connected) process.send({ event: "error", message: String(error) }); }
    });
    process.send({ event: "ready" });
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const messages: Record<string, unknown>[] = [];
  child.on("message", (message) => { messages.push(message as Record<string, unknown>); });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`fixture exited ${code}: ${stderr}`)));
  });
  void exited.catch(() => {});
  async function wait(event: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`fixture event timed out: ${event}: ${stderr}`)); }, 5000);
      const check = () => {
        const error = messages.find((item) => item.event === "error");
        const result = messages.find((item) => item.event === event);
        if (error !== undefined) { cleanup(); reject(new Error(String(error.message))); }
        else if (result !== undefined) { cleanup(); resolve(result); }
      };
      const cleanup = () => { clearTimeout(timer); child.off("message", check); };
      child.on("message", check);
      check();
    });
  }
  return { child, wait, exited };
}

async function closeFixture(child: ChildProcess, exited: Promise<void>) {
  if (child.connected) child.send("stop");
  await exited;
}

it("coordinates cross-process refreshers behind a controlled owner and publishes one generation", async () => {
  const { root, cacheDir } = await fixture();
  const owner = childFixture(root, cacheDir, "hold");
  const clients: ReturnType<typeof childFixture>[] = [];
  try {
    await owner.wait("ready");
    owner.child.send("start");
    await owner.wait("acquired");
    for (let i = 0; i < 3; i += 1) clients.push(childFixture(root, cacheDir, "refresh"));
    await Promise.all(clients.map((client) => client.wait("ready")));
    for (const client of clients) client.child.send("start");
    await fs.writeFile(path.join(root, "b.ts"), "export const b = 2;\n");
    await fs.unlink(path.join(root, "a.ts"));
    owner.child.send("release");
    await owner.wait("released");
    const results = await Promise.all(clients.map((client) => client.wait("result")));
    expect(new Set(results.map((result) => result.generation)).size).toBe(1);
    expect(results.every((result) => JSON.stringify(result.paths) === '["b.ts"]')).toBe(true);
    expect(indexGeneration((await loadIndex(root, { cacheDir }))!)).toBe(results[0]?.generation);
  } finally {
    await Promise.all([owner, ...clients].map((client) => closeFixture(client.child, client.exited)));
  }
}, 10_000);

it("recovers a verified exited fixture owner without deleting unknown locks", async () => {
  const { root, cacheDir } = await fixture();
  const owner = childFixture(root, cacheDir, "abandon");
  const clients: ReturnType<typeof childFixture>[] = [];
  try {
    await owner.wait("ready");
    owner.child.send("start");
    await owner.wait("acquired");
    await owner.exited;
    for (let i = 0; i < 3; i += 1) clients.push(childFixture(root, cacheDir, "refresh"));
    await Promise.all(clients.map((client) => client.wait("ready")));
    for (const client of clients) client.child.send("start");
    const results = await Promise.all(clients.map((client) => client.wait("result")));
    expect(new Set(results.map((result) => result.generation)).size).toBe(1);
    const lockPath = workspaceLockPath(cacheDir, root);
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, "unknown"), "preserve");
    await expect(refreshWorkspace(root, { cacheDir, lockTimeoutMs: 20, lockPollMs: 5 })).rejects.toThrow(/cache-lock-timeout/);
    expect(await fs.readFile(path.join(lockPath, "unknown"), "utf8")).toBe("preserve");
  } finally {
    await Promise.all([owner, ...clients].map((client) => closeFixture(client.child, client.exited)));
  }
});

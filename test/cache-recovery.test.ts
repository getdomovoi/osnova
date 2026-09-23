import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { refreshWorkspace } from "../src/api.js";
import { buildIndex } from "../src/index/build.js";
import { loadArtifact, serializeArtifact } from "../src/index/serialize.js";
import { sha256Hex } from "../src/index/scan.js";
import { evictLru, workspaceDirFor } from "../src/cache/cache.js";
import { withCacheLock } from "../src/cache/lock.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function workspaces(names: readonly string[]): Promise<{ roots: string[]; cacheDir: string }> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "osnova-cache-recovery-")));
  temporary.push(dir);
  const roots: string[] = [];
  for (const name of names) {
    const root = path.join(dir, name);
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "a.ts"), `export function ${name}(): number { return 1; }\n`);
    roots.push(root);
  }
  const cacheDir = path.join(dir, "cache");
  await fs.mkdir(cacheDir);
  return { roots, cacheDir };
}

async function holdLock(lockPath: string): Promise<{ release: () => Promise<void> }> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const holding = withCacheLock(lockPath, () => gate);
  while (!(await fs.stat(lockPath).then(() => true, () => false))) await new Promise((resolve) => setTimeout(resolve, 5));
  return { release: async () => { open(); await holding; } };
}

it("recovers every workspace from an eviction lock left without an owner", async () => {
  const { roots, cacheDir } = await workspaces(["alpha", "beta"]);
  for (const root of roots) await refreshWorkspace(root, { cacheDir });
  const eviction = path.join(cacheDir, ".eviction.lock");
  await fs.mkdir(eviction);
  const then = new Date(Date.now() - 60_000);
  await fs.utimes(eviction, then, then);
  for (const root of roots) {
    const started = performance.now();
    const index = await refreshWorkspace(root, { cacheDir, lockTimeoutMs: 3_000 });
    expect(index.files.size).toBe(1);
    expect(performance.now() - started).toBeLessThan(3_000);
  }
  await expect(fs.stat(eviction)).rejects.toMatchObject({ code: "ENOENT" });
});

it("names the contended eviction lock and honours the caller's timeout", async () => {
  const { roots: [root], cacheDir } = await workspaces(["gamma"]);
  await refreshWorkspace(root!, { cacheDir });
  const eviction = path.join(cacheDir, ".eviction.lock");
  const holder = await holdLock(eviction);
  const started = performance.now();
  const error = await refreshWorkspace(root!, { cacheDir, lockTimeoutMs: 300, lockPollMs: 10 }).catch((caught: unknown) => caught as Error);
  const elapsed = performance.now() - started;
  await holder.release();
  expect(error).toMatchObject({ diagnostic: { code: "cache-lock-timeout", path: eviction } });
  expect((error as Error).message).toContain(eviction);
  expect(elapsed).toBeLessThan(3_000);
});

it("does not evict a base tree while another process holds its base lock", async () => {
  const { roots, cacheDir } = await workspaces(["delta", "epsilon"]);
  for (const root of roots) await buildIndex(root, { cacheDir });
  const victim = workspaceDirFor(cacheDir, roots[0]!);
  const tree = path.join(victim, "base", "0123456789abcdef", "tree");
  await fs.mkdir(tree, { recursive: true });
  await fs.writeFile(path.join(tree, "a.ts"), "export const kept = 1;\n");
  const holder = await holdLock(path.join(victim, "base", ".lock"));
  await evictLru(cacheDir, { maxWorkspaces: 1 });
  const survived = await fs.readFile(path.join(tree, "a.ts"), "utf8").catch(() => undefined);
  const released = await holder.release().then(() => "released", (error: unknown) => (error as Error).message);
  expect(survived).toBe("export const kept = 1;\n");
  expect(released).toBe("released");
  await evictLru(cacheDir, { maxWorkspaces: 0 });
  await expect(fs.stat(victim)).rejects.toMatchObject({ code: "ENOENT" });
});

it("sweeps the lock directories a killed process left under private names, and only those", async () => {
  const { roots: [root], cacheDir } = await workspaces(["iota"]);
  await buildIndex(root!, { cacheDir });
  const dead = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.once("exit", () => resolve(child.pid!));
  });
  const debris = async (name: string, pid: number): Promise<void> => {
    await fs.mkdir(path.join(cacheDir, name));
    await fs.writeFile(path.join(cacheDir, name, "owner.json"), JSON.stringify({ pid, host: os.hostname(), token: randomUUID() }));
  };
  const lockName = `${path.basename(workspaceDirFor(cacheDir, root!))}.lock`;
  await debris(`${lockName}.released-${randomUUID()}`, dead);
  await debris(`.eviction.lock.acquire-${randomUUID()}`, dead);
  const live = `${lockName}.acquire-${randomUUID()}`;
  await debris(live, process.pid);
  await evictLru(cacheDir);
  expect((await fs.readdir(cacheDir)).filter((name) => name.includes(".lock."))).toEqual([live]);
});

it("rebuilds a core artifact that cannot be decompressed instead of failing every refresh", async () => {
  const { roots: [root], cacheDir } = await workspaces(["zeta"]);
  const index = await refreshWorkspace(root!, { cacheDir });
  const target = path.join(workspaceDirFor(cacheDir, root!), "index.json");
  await fs.writeFile(target, gzipSync(serializeArtifact(index)).subarray(0, 20));
  await expect(loadArtifact(root!, cacheDir)).rejects.toThrow(/cache-read-failed/);
  const rebuilt = await refreshWorkspace(root!, { cacheDir });
  expect([...rebuilt.files.keys()]).toEqual(["a.ts"]);
  expect((await loadArtifact(root!, cacheDir))?.files.size).toBe(1);
});

it.each([
  ["unchanged", []],
  ["changed", ["b.ts"]],
] as const)("rebuilds a checksum-consistent core whose body is corrupt when the workspace is %s", async (_state, added) => {
  const { roots: [root], cacheDir } = await workspaces(["eta"]);
  await refreshWorkspace(root!, { cacheDir });
  const dir = workspaceDirFor(cacheDir, root!);
  const data = JSON.parse(await fs.readFile(path.join(dir, "index.json"), "utf8")) as { files: Array<{ hash: string }> };
  data.files[0]!.hash = "bad";
  const raw = Buffer.from(JSON.stringify(data));
  await fs.writeFile(path.join(dir, "index.json"), raw);
  await fs.writeFile(path.join(dir, "index.sha"), `${sha256Hex(raw)}\n`);
  for (const name of added) await fs.writeFile(path.join(root!, name), "export const b = 2;\n");
  const rebuilt = await refreshWorkspace(root!, { cacheDir });
  expect([...rebuilt.files.keys()].sort()).toEqual(["a.ts", ...added]);
  expect((await loadArtifact(root!, cacheDir))?.files.size).toBe(1 + added.length);
});

it("still fails closed when the core cannot be read at all", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const { roots: [root], cacheDir } = await workspaces(["theta"]);
  await refreshWorkspace(root!, { cacheDir });
  const target = path.join(workspaceDirFor(cacheDir, root!), "index.json");
  await fs.writeFile(path.join(root!, "a.ts"), "export const changed = 3;\n");
  await fs.chmod(target, 0);
  try {
    await expect(refreshWorkspace(root!, { cacheDir })).rejects.toThrow(/cache-read-failed/);
  } finally {
    await fs.chmod(target, 0o644);
  }
});

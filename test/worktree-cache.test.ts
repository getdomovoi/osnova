import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshWorkspace } from "../src/api.js";
import { buildIndex } from "../src/index/build.js";
import { workspaceDirFor, workspaceLockPath } from "../src/cache/cache.js";
import { loadFamily, workspaceFamily } from "../src/cache/family.js";
import { withCacheLock } from "../src/cache/lock.js";
import { doctor } from "../src/diagnostics/doctor.js";
import type { ProgressEvent } from "../src/types.js";

const temporary: string[] = [];
const artifactNames = ["index.json", "index.sha", "edges.json", "text.bin"] as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=osnova", "-c", "user.email=osnova@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

async function fixture() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "osnova-worktree-cache-")));
  temporary.push(dir);
  const main = path.join(dir, "main");
  await fs.mkdir(main);
  await fs.writeFile(path.join(main, "a.ts"), "export function a(): number { return b(); }\nexport function b(): number { return 1; }\n");
  await fs.writeFile(path.join(main, "c.ts"), "import { a } from './a.js';\nexport const c = a();\n");
  git(main, "init", "-q", "-b", "main");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "seed");
  const linked = path.join(dir, "linked");
  git(main, "worktree", "add", "-q", "--detach", linked, "HEAD");
  const plain = path.join(dir, "plain");
  await fs.mkdir(plain);
  await fs.writeFile(path.join(plain, "a.ts"), "export const a = 1;\n");
  return { dir, main, linked, plain, cacheA: path.join(dir, "cacheA"), cacheB: path.join(dir, "cacheB") };
}

async function artifacts(cacheDir: string, root: string): Promise<Record<string, Buffer>> {
  const dir = workspaceDirFor(await fs.realpath(cacheDir), root);
  const out: Record<string, Buffer> = {};
  for (const name of artifactNames) out[name] = await fs.readFile(path.join(dir, name));
  return out;
}

function seeds(progress: ReturnType<typeof vi.fn>): ProgressEvent[] {
  return progress.mock.calls.map(([event]) => event as ProgressEvent).filter((event) => event.phase === "seed");
}

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.OSNOVA_CACHE_SEED;
  await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it("derives one family id for the main and linked worktrees and none for a plain directory", async () => {
  const { main, linked, plain } = await fixture();
  const family = await workspaceFamily(main);
  expect(family).toBe(await fs.realpath(path.join(main, ".git")));
  expect(await workspaceFamily(linked)).toBe(family);
  expect(await workspaceFamily(plain)).toBeUndefined();
  expect(await workspaceFamily(path.join(main, "sub-missing"))).toBeUndefined();
});

it("seeds a new worktree only from a verified sibling and records the family in a sidecar", async () => {
  const { main, linked, cacheA } = await fixture();
  await buildIndex(main, { cacheDir: cacheA });
  const cache = await fs.realpath(cacheA);
  expect(await loadFamily(cache, main)).toEqual({ family: await workspaceFamily(main), root: main });
  await fs.rm(path.join(workspaceDirFor(cache, main), "verification.json"));
  const unverified = vi.fn();
  await refreshWorkspace(linked, { cacheDir: cacheA, onProgress: unverified });
  expect(seeds(unverified)).toEqual([]);
  await fs.rm(workspaceDirFor(cache, linked), { recursive: true });
  await refreshWorkspace(main, { cacheDir: cacheA });
  const verified = vi.fn();
  await refreshWorkspace(linked, { cacheDir: cacheA, onProgress: verified });
  expect(seeds(verified)).toEqual([{ phase: "seed", done: 2, total: 2, sibling: main }]);
  expect(await loadFamily(cache, linked)).toEqual({ family: await workspaceFamily(main), root: linked });
  const again = vi.fn();
  await refreshWorkspace(linked, { cacheDir: cacheA, onProgress: again });
  expect(seeds(again)).toEqual([]);
});

it("produces the same artifact bytes when seeded from a sibling as when built cold", async () => {
  const { main, linked, cacheA, cacheB } = await fixture();
  await buildIndex(main, { cacheDir: cacheA });
  await fs.writeFile(path.join(linked, "a.ts"), "export function a(): number { return 2; }\nexport function b(): number { return a(); }\n");
  await fs.writeFile(path.join(linked, "d.ts"), "import { b } from './a.js';\nexport const d = b();\n");
  await fs.rm(path.join(linked, "c.ts"));
  const progress = vi.fn();
  const seeded = await refreshWorkspace(linked, { cacheDir: cacheA, onProgress: progress });
  expect(seeds(progress)).toEqual([{ phase: "seed", done: 0, total: 2, sibling: main }]);
  expect([...seeded.files.keys()]).toEqual(["a.ts", "d.ts"]);
  process.env.OSNOVA_CACHE_SEED = "0";
  const cold = vi.fn();
  await refreshWorkspace(linked, { cacheDir: cacheB, onProgress: cold });
  expect(seeds(cold)).toEqual([]);
  const a = await artifacts(cacheA, linked);
  const b = await artifacts(cacheB, linked);
  for (const name of artifactNames) expect(a[name]!.equals(b[name]!), name).toBe(true);
  const cliCold = vi.fn();
  delete process.env.OSNOVA_CACHE_SEED;
  await buildIndex(linked, { cacheDir: path.join(cacheB, "..", "cacheC"), onProgress: cliCold, seedFromSiblings: false });
  expect(seeds(cliCold)).toEqual([]);
  const c = await artifacts(path.join(cacheB, "..", "cacheC"), linked);
  for (const name of artifactNames) expect(a[name]!.equals(c[name]!), name).toBe(true);
});

it("keeps one cache directory and one lock per worktree", async () => {
  const { main, linked, cacheA } = await fixture();
  await buildIndex(main, { cacheDir: cacheA });
  const cache = await fs.realpath(cacheA);
  expect(workspaceDirFor(cache, main)).not.toBe(workspaceDirFor(cache, linked));
  expect(workspaceLockPath(cache, main)).not.toBe(workspaceLockPath(cache, linked));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holding = withCacheLock(workspaceLockPath(cache, main), () => gate);
  while (!(await fs.stat(workspaceLockPath(cache, main)).then(() => true, () => false))) await new Promise((resolve) => setTimeout(resolve, 5));
  const progress = vi.fn();
  const index = await refreshWorkspace(linked, { cacheDir: cacheA, onProgress: progress, lockTimeoutMs: 200 });
  expect(index.root).toBe(linked);
  expect(seeds(progress)).toEqual([]);
  expect(await fs.readdir(cache).then((names) => names.filter((name) => name.endsWith(".lock")))).toEqual([path.basename(workspaceLockPath(cache, main))]);
  release();
  await holding;
  const retry = vi.fn();
  await fs.rm(workspaceDirFor(cache, linked), { recursive: true });
  await refreshWorkspace(linked, { cacheDir: cacheA, onProgress: retry });
  expect(seeds(retry)).toEqual([{ phase: "seed", done: 2, total: 2, sibling: main }]);
});

it("doctor reports the family and its sibling caches", async () => {
  const { main, linked, plain, cacheA } = await fixture();
  await buildIndex(main, { cacheDir: cacheA });
  await buildIndex(linked, { cacheDir: cacheA });
  const report = await doctor(linked, { cacheDir: cacheA });
  const check = report.checks.find((item) => item.id === "cache:family");
  expect(check?.status).toBe("ok");
  expect(check?.message).toContain(await workspaceFamily(main));
  expect(check?.message).toContain(main);
  expect(check?.message).not.toContain(linked);
  const none = await doctor(plain, { cacheDir: cacheA });
  expect(none.checks.find((item) => item.id === "cache:family")?.message).toMatch(/no cache family/i);
});

import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceLockPath } from "../src/cache/cache.js";
import { withCacheLock } from "../src/cache/lock.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");
const children = new Set<ChildProcess>();
const temporary: string[] = [];

afterEach(async () => {
  // Killing is not exiting. Windows keeps the handles of a dying child open for a moment, so the
  // removal below answers EBUSY unless the exit is awaited first and the removal itself retries.
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }));
  children.clear();
  await Promise.all(temporary.splice(0).map((dir) =>
    fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })));
});

async function fixture(): Promise<{ root: string; cacheDir: string }> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "osnova-lifecycle-")));
  temporary.push(dir);
  const root = path.join(dir, "root");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "a.ts"), "export function a(): number { return 1; }\n");
  const cacheDir = path.join(dir, "cache");
  await fs.mkdir(cacheDir);
  return { root, cacheDir };
}

interface Run { readonly child: ChildProcess; readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> }

function run(args: readonly string[], nodeArgs: readonly string[] = [], env: NodeJS.ProcessEnv = {}): Run {
  const child = spawn(process.execPath, [...nodeArgs, BIN, ...args], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ...env } });
  children.add(child);
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
  return { child, exited };
}

async function ownerPid(lockPath: string): Promise<number | undefined> {
  try {
    return (JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as { pid: number }).pid;
  } catch {
    return undefined;
  }
}

// The child builds while this process holds the cache-wide eviction lock, so it stays parked inside
// its own workspace lock until the signal arrives.
async function parkedBuild(nodeArgs: readonly string[] = [], waitForLock = true): Promise<{ run: Run; lockPath: string; cacheDir: string; release: () => Promise<void> }> {
  const { root, cacheDir } = await fixture();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const holding = withCacheLock(path.join(cacheDir, ".eviction.lock"), () => gate);
  const lockPath = workspaceLockPath(cacheDir, root);
  const started = run(["build", root, "--cache-dir", cacheDir], nodeArgs, { OSNOVA_PROBE_LOCK: lockPath });
  const deadline = Date.now() + 30_000;
  while (waitForLock && (await ownerPid(lockPath)) !== started.child.pid) {
    if (Date.now() > deadline) throw new Error("the child never took its workspace lock");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { run: started, lockPath, cacheDir, release: async () => { open(); await holding; } };
}

it.skipIf(process.platform === "win32").each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const)("releases the cache locks it holds when it receives %s", async (signal, expected) => {
  const parked = await parkedBuild();
  parked.run.child.kill(signal);
  const result = await parked.run.exited;
  await parked.release();
  expect({ code: result.code, signal: result.signal }).toEqual({ code: expected, signal: null });
  await expect(fs.stat(parked.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await fs.readdir(parked.cacheDir)).filter((name) => name.includes(".lock."))).toEqual([]);
});

it("reports an unhandled rejection as an osnova error, releases its locks and exits 2", async () => {
  const source = [
    "import { readFileSync } from 'node:fs';",
    "const timer = setInterval(() => {",
    "  let pid; try { pid = JSON.parse(readFileSync(process.env.OSNOVA_PROBE_LOCK + '/owner.json', 'utf8')).pid; } catch { return; }",
    "  if (pid !== process.pid) return;",
    "  clearInterval(timer);",
    "  Promise.reject(new Error('probe-rejection'));",
    "}, 20);",
  ].join("\n");
  const parked = await parkedBuild(["--import", `data:text/javascript,${encodeURIComponent(source)}`], false);
  const result = await parked.run.exited;
  await parked.release();
  expect(result.code).toBe(2);
  expect(result.stderr).toMatch(/^osnova: unhandled rejection: Error: probe-rejection/);
  await expect(fs.stat(parked.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("prints an error that already names osnova with a single prefix", async () => {
  const { cacheDir } = await fixture();
  const result = await run(["build", path.join(cacheDir, "missing"), "--cache-dir", cacheDir]).exited;
  expect(result.code).toBe(2);
  expect(result.stderr).toMatch(/^osnova: scan failed for /);
});

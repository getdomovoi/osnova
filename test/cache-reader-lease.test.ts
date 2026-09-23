import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildIndex, loadIndex } from "../src/index.js";
import { workspaceDirFor } from "../src/cache/cache.js";
import { withCacheLock } from "../src/cache/lock.js";
import type { OsnovaIndexImpl } from "../src/index/indexImpl.js";

const root = path.resolve(import.meta.dirname, "..");
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

async function scratch(): Promise<{ cacheDir: string; a: string; b: string }> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "osnova-reader-lease-")));
  dirs.push(dir);
  const a = path.join(dir, "a"); const b = path.join(dir, "b");
  for (const [ws, name] of [[a, "alpha"], [b, "beta"]] as const) {
    await fs.mkdir(path.join(ws, "src"), { recursive: true });
    await fs.writeFile(path.join(ws, "src", `${name}.ts`), `export function ${name}() { return "${name}".repeat(4); }\n`);
  }
  return { cacheDir: path.join(dir, "cache"), a, b };
}

// A second process publishes ws-b into a cache capped at one workspace, which evicts every other
// workspace it is allowed to.
function publishElsewhere(cacheDir: string, workspace: string): void {
  const script = `import { buildIndex } from ${JSON.stringify(pathToFileURL(path.join(root, "src", "index.ts")).href)};\nawait buildIndex(${JSON.stringify(workspace)}, { cacheDir: ${JSON.stringify(cacheDir)}, maxWorkspaces: 1 });\n`;
  execFileSync(process.execPath, ["--import", tsx, "--input-type=module", "-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function exitedPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

describe("reader leases", () => {
  it("records this process as a reader of a loaded artifact", async () => {
    const { cacheDir, a } = await scratch();
    await buildIndex(a, { cacheDir });
    const index = (await loadIndex(a, { cacheDir }))!;
    const lease = JSON.parse(await fs.readFile(path.join(workspaceDirFor(cacheDir, index.root), "readers", `${process.pid}.json`), "utf8")) as { pid: number; host: string };
    expect(lease.pid).toBe(process.pid);
    expect(lease.host).toBe(os.hostname());
  });

  it("spares a workspace that a live process loaded lazily when another process evicts", async () => {
    const { cacheDir, a, b } = await scratch();
    await buildIndex(a, { cacheDir });
    const index = (await loadIndex(a, { cacheDir })) as OsnovaIndexImpl;
    expect(index.edgesLoaded()).toBe(false);
    publishElsewhere(cacheDir, b);
    const dirA = workspaceDirFor(cacheDir, a);
    expect((await fs.readdir(dirA)).sort()).toContain("text.bin");
    const card = [...index.files.values()].find((file) => file.path.endsWith("alpha.ts"))!;
    expect(card.text).toContain("alpha");
    expect(index.edges.length).toBeGreaterThanOrEqual(0);
    await expect(fs.stat(workspaceDirFor(cacheDir, b))).resolves.toBeDefined();
  });

  it("does not let a reader that has exited protect its workspace, and removes its lease", async () => {
    const { cacheDir, a, b } = await scratch();
    const built = await buildIndex(a, { cacheDir });
    const dirA = workspaceDirFor(cacheDir, built.root);
    await fs.mkdir(path.join(dirA, "readers"), { recursive: true });
    const dead = exitedPid();
    await fs.writeFile(path.join(dirA, "readers", `${dead}.json`), JSON.stringify({ pid: dead, host: os.hostname(), token: "00000000-0000-4000-8000-000000000000" }));
    publishElsewhere(cacheDir, b);
    await expect(fs.stat(path.join(dirA, "text.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(dirA, "readers", `${dead}.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a busy eviction lock met while loading as cache-lock-timeout, not cache-read-failed", async () => {
    const { cacheDir, a } = await scratch();
    await buildIndex(a, { cacheDir });
    const busy = path.join(cacheDir, ".eviction.lock");
    await fs.mkdir(busy);
    await fs.writeFile(path.join(busy, "owner.json"), JSON.stringify({ pid: process.pid, host: os.hostname(), token: "00000000-0000-4000-8000-000000000001" }));
    const load = withCacheLock(path.join(cacheDir, "unrelated.lock"), () => loadIndex(a, { cacheDir }), { lockTimeoutMs: 50, lockPollMs: 5 });
    await expect(load).rejects.toMatchObject({ diagnostic: { code: "cache-lock-timeout", path: busy } });
  });

  it("still evicts an unread workspace, so the cap holds when nothing is in use", async () => {
    const { cacheDir, a, b } = await scratch();
    const built = await buildIndex(a, { cacheDir });
    publishElsewhere(cacheDir, b);
    await expect(fs.stat(path.join(workspaceDirFor(cacheDir, built.root), "text.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

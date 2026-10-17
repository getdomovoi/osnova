import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cacheFs, ensureCacheDir, withBoundCacheDir } from "../src/cache/bound.js";

const temporaries: string[] = [];
afterEach(async () => { for (const dir of temporaries.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

// A parent p holding the cache directory, and a directory q holding a cache directory of the same name.
async function parentAndElsewhere(): Promise<{ parent: string; elsewhere: string; cacheDir: string }> {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "osnova-cache-bound-")));
  temporaries.push(temporary);
  const parent = path.join(temporary, "p");
  const elsewhere = path.join(temporary, "q");
  await fs.mkdir(path.join(parent, "cache"), { recursive: true });
  await fs.mkdir(path.join(elsewhere, "cache"), { recursive: true });
  return { parent, elsewhere, cacheDir: path.join(parent, "cache") };
}

async function retarget(parent: string, elsewhere: string): Promise<void> {
  await fs.rename(parent, `${parent}-saved`);
  await fs.symlink(elsewhere, parent, "dir");
}

describe.runIf(process.platform === "linux")("withBoundCacheDir", () => {
  it("keeps cache writes in the directory it bound when a parent of the cache is retargeted", async () => {
    const { parent, elsewhere, cacheDir } = await parentAndElsewhere();
    const identity = await ensureCacheDir(cacheDir);
    await withBoundCacheDir(cacheDir, identity, async () => {
      await retarget(parent, elsewhere);
      await cacheFs.mkdir(path.join(cacheDir, "entry"), { recursive: true });
      await cacheFs.writeFile(path.join(cacheDir, "entry", "file.tmp"), "bound");
      await cacheFs.rename(path.join(cacheDir, "entry", "file.tmp"), path.join(cacheDir, "entry", "file"));
    });
    expect(await fs.readFile(path.join(`${parent}-saved`, "cache", "entry", "file"), "utf8")).toBe("bound");
    expect(await fs.readdir(path.join(elsewhere, "cache"))).toEqual([]);
  });

  it("names the cache directory, never the descriptor, in the errors and paths it returns", async () => {
    const { cacheDir } = await parentAndElsewhere();
    const identity = await ensureCacheDir(cacheDir);
    const missing = path.join(cacheDir, "entry", "missing");
    const outcome = await withBoundCacheDir(cacheDir, identity, async () => {
      const created = await cacheFs.mkdir(path.join(cacheDir, "made", "deeper"), { recursive: true });
      const error = await cacheFs.readFile(missing).then(() => undefined, (failure: unknown) => failure as NodeJS.ErrnoException);
      return { created, error };
    });
    expect(outcome.created).toBe(path.join(cacheDir, "made"));
    expect(outcome.error).toMatchObject({ code: "ENOENT", path: missing });
    expect(outcome.error?.message).toContain(`'${missing}'`);
    expect(outcome.error?.message).not.toContain("/proc/self/fd");
  });

  it("uses the path as given for a call that outlives the operation", async () => {
    const { parent, elsewhere, cacheDir } = await parentAndElsewhere();
    const identity = await ensureCacheDir(cacheDir);
    let late!: Promise<void>;
    await withBoundCacheDir(cacheDir, identity, async () => {
      late = new Promise((resolve, reject) => {
        setTimeout(() => { cacheFs.writeFile(path.join(cacheDir, "late"), "late").then(resolve, reject); }, 20);
      });
    });
    await retarget(parent, elsewhere);
    await late;
    expect(await fs.readFile(path.join(elsewhere, "cache", "late"), "utf8")).toBe("late");
    expect(await fs.readdir(path.join(`${parent}-saved`, "cache"))).toEqual([]);
  });

  it("fails instead of binding a directory other than the one the identity names", async () => {
    const { parent, elsewhere, cacheDir } = await parentAndElsewhere();
    const identity = await ensureCacheDir(cacheDir);
    await retarget(parent, elsewhere);
    await expect(withBoundCacheDir(cacheDir, identity, async () => "ran")).rejects.toMatchObject({ diagnostic: { code: "cache-changing" } });
  });
});

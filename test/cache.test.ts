import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCacheDir, workspaceDirFor, evictLru } from "../src/cache/cache.js";
import { saveArtifact, loadArtifact } from "../src/index/serialize.js";
import { buildIndex } from "../src/index/build.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "osnova-cache-"));
}

function fixtureCopy(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-cache-fixture-"));
  fs.cpSync(path.join(import.meta.dirname, "fixtures", "sample-repo"), dir, { recursive: true });
  return dir;
}

describe("cache dir resolution", () => {
  it("prefers explicit parameter over env over platform default", () => {
    const previous = process.env.OSNOVA_CACHE_DIR;
    try {
      delete process.env.OSNOVA_CACHE_DIR;
      const explicit = tmpDir();
      expect(resolveCacheDir(explicit)).toBe(explicit);

      process.env.OSNOVA_CACHE_DIR = "/tmp/env-cache";
      expect(resolveCacheDir()).toBe("/tmp/env-cache");
      expect(resolveCacheDir(explicit)).toBe(explicit);

      delete process.env.OSNOVA_CACHE_DIR;
      const fallback = resolveCacheDir();
      expect(fallback.endsWith("osnova") || fallback.includes(path.join("osnova", "cache"))).toBe(true);
    } finally {
      if (previous !== undefined) process.env.OSNOVA_CACHE_DIR = previous;
      else delete process.env.OSNOVA_CACHE_DIR;
    }
  });

  it("derives a stable workspace key from the absolute root", () => {
    const a = workspaceDirFor(tmpDir(), path.resolve("test/fixtures/sample-repo"));
    const b = workspaceDirFor(tmpDir(), path.resolve("test/fixtures/sample-repo"));
    expect(path.basename(a)).toBe(path.basename(b));
    expect(path.basename(a)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("artifact save and load", () => {
  it("round-trips an index through the cache", async () => {
    const cacheDir = tmpDir();
    const root = fixtureCopy();
    try {
      const index = await buildIndex(root, { cacheDir });
      const loaded = await loadArtifact(root, cacheDir);
      expect(loaded).toBeDefined();
      expect(loaded?.files.size).toBe(index.files.size);
      expect(loaded?.edges.length).toBe(index.edges.length);
      expect(loaded?.symbols.get("src/util.ts#pad")).toBeDefined();
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns undefined when no artifact exists", async () => {
    const cacheDir = tmpDir();
    try {
      expect(await loadArtifact("/nonexistent-root", cacheDir)).toBeUndefined();
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("evicts the least recently used workspace beyond the cap", async () => {
    const cacheDir = tmpDir();
    try {
      const roots: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const root = fixtureCopy();
        roots.push(root);
        const index = await buildIndex(root, { cacheDir });
        await saveArtifact(index, cacheDir);
      }
      await evictLru(cacheDir, 2);
      const remaining = fs.readdirSync(cacheDir);
      expect(remaining).toHaveLength(2);
      for (const dir of remaining) {
        expect(dir).toMatch(/^[0-9a-f]{16}$/);
      }
      for (const root of roots) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

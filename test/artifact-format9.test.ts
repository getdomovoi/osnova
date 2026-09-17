import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { loadIndex, indexGeneration } from "../src/api.js";
import { serializeArtifact, serializeSections } from "../src/index/serialize.js";
import { workspaceDirFor } from "../src/cache/cache.js";
import { sha256Hex } from "../src/index/scan.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-repo");
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function scratch(): Promise<string> { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-fmt9-")); dirs.push(dir); return dir; }

describe("format 9", () => {
  it("writes core, sha, edges and text with string tables", async () => {
    const dir = await scratch(); const cacheDir = path.join(dir, "cache");
    const index = await buildIndex(FIXTURE, { cacheDir });
    const ws = workspaceDirFor(cacheDir, index.root);
    const names = (await fs.readdir(ws)).sort();
    for (const f of ["index.json", "index.sha", "edges.json", "text.bin"]) expect(names).toContain(f);
    const core = JSON.parse((await fs.readFile(path.join(ws, "index.json"))).toString("utf8")) as { formatVersion: number; paths: string[]; names: string[]; edgesHash: string; edgesBytes: number; files: Array<{ p: number; symbols: Array<{ n: number }> }> };
    expect(core.formatVersion).toBe(9);
    expect(core.paths).toEqual([...core.paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(core.files.every((f) => Number.isInteger(f.p) && f.p < core.paths.length)).toBe(true);
    expect(core.files.every((f) => f.symbols.every((s) => Number.isInteger(s.n) && s.n < core.names.length))).toBe(true);
    const edgesBytes = await fs.readFile(path.join(ws, "edges.json"));
    expect(sha256Hex(edgesBytes)).toBe(core.edgesHash);
    expect(edgesBytes.length).toBe(core.edgesBytes);
    expect((await fs.readFile(path.join(ws, "index.sha"), "utf8")).trim()).toBe(sha256Hex(serializeArtifact(index)));
    expect(JSON.stringify(core)).not.toContain('"checksum"');
  });

  it("verifies the edge section at load, decodes it on the first edge query, and never opens text.bin eagerly", async () => {
    const dir = await scratch(); const cacheDir = path.join(dir, "cache");
    const built = await buildIndex(FIXTURE, { cacheDir });
    const opened: string[] = [];
    const open = fsSync.openSync;
    vi.spyOn(fsSync, "openSync").mockImplementation((p, ...rest) => { opened.push(String(p)); return open(p, ...rest as [never]); });
    const readFile = fs.readFile;
    vi.spyOn(fs, "readFile").mockImplementation(async (p, ...rest) => { opened.push(String(p)); return readFile(p, ...rest as [never]); });
    const loaded = (await loadIndex(FIXTURE, { cacheDir }))!;
    expect(opened.some((p) => p.endsWith("edges.json"))).toBe(true);
    expect(opened.some((p) => p.endsWith("text.bin"))).toBe(false);
    expect((loaded as unknown as { edgesLoaded: () => boolean }).edgesLoaded()).toBe(false);
    expect(loaded.files.size).toBe(built.files.size);
    expect(loaded.symbols.size).toBe(built.symbols.size);
    expect(loaded.outgoing("src/util.ts#compute").map((e) => e.toSymbol)).toEqual(built.outgoing("src/util.ts#compute").map((e) => e.toSymbol));
    expect((loaded as unknown as { edgesLoaded: () => boolean }).edgesLoaded()).toBe(true);
    expect(loaded.edges).toEqual(built.edges);
    expect(indexGeneration(loaded)).toBe(indexGeneration(built));
  });

  it("re-serializes a loaded index to identical section bytes", async () => {
    const dir = await scratch(); const cacheDir = path.join(dir, "cache");
    const built = await buildIndex(FIXTURE, { cacheDir });
    const loaded = (await loadIndex(FIXTURE, { cacheDir }))!;
    const a = serializeSections(built); const b = serializeSections(loaded);
    expect(b.core.equals(a.core)).toBe(true);
    expect(b.edges.bytes.equals(a.edges.bytes)).toBe(true);
    expect(b.text.bytes.equals(a.text.bytes)).toBe(true);
  });

  it("fails closed on a torn or mismatched section and rebuilds through refreshWorkspace", async () => {
    const { refreshWorkspace } = await import("../src/api.js");
    const dir = await scratch(); const cacheDir = path.join(dir, "cache");
    const index = await buildIndex(FIXTURE, { cacheDir });
    const ws = workspaceDirFor(cacheDir, index.root);
    for (const victim of ["edges.json", "index.sha", "text.bin"]) {
      const file = path.join(ws, victim);
      const original = await fs.readFile(file);
      await fs.appendFile(file, "x");
      await expect(loadIndex(FIXTURE, { cacheDir })).rejects.toMatchObject({ diagnostic: { code: "cache-read-failed" } });
      const refreshed = await refreshWorkspace(FIXTURE, { cacheDir });
      expect(indexGeneration(refreshed)).toBe(indexGeneration(index));
      expect((await fs.readFile(file)).equals(original)).toBe(true);
    }
    const shaFile = path.join(ws, "index.sha");
    await fs.writeFile(shaFile, `${"0".repeat(64)}\n`);
    await expect(loadIndex(FIXTURE, { cacheDir })).rejects.toMatchObject({ diagnostic: { code: "cache-read-failed" } });
    const refreshedAfterMismatch = await refreshWorkspace(FIXTURE, { cacheDir });
    expect(indexGeneration(refreshedAfterMismatch)).toBe(indexGeneration(index));
  });

  it("rejects a same-size edge corruption at load and rebuilds through refreshWorkspace", async () => {
    const { refreshWorkspace } = await import("../src/api.js");
    const { gzipSync } = await import("node:zlib");
    for (const wrap of [(b: Buffer): Buffer => b, (b: Buffer): Buffer => gzipSync(b, { level: 1 })]) {
      const dir = await scratch(); const cacheDir = path.join(dir, "cache");
      const repo = path.join(dir, "repo");
      await fs.cp(FIXTURE, repo, { recursive: true });
      const index = await buildIndex(repo, { cacheDir });
      const edgesFile = path.join(workspaceDirFor(cacheDir, index.root), "edges.json");
      const original = await fs.readFile(edgesFile);
      const tampered = Buffer.from(original.toString("utf8").replace("compute", "comput3"), "utf8");
      expect(tampered.length).toBe(original.length);
      expect(tampered.equals(original)).toBe(false);
      await fs.writeFile(edgesFile, wrap(tampered));
      await expect(loadIndex(repo, { cacheDir })).rejects.toMatchObject({ diagnostic: { code: "cache-read-failed" } });
      const refreshed = await refreshWorkspace(repo, { cacheDir });
      expect(indexGeneration(refreshed)).toBe(indexGeneration(index));
      expect((await fs.readFile(edgesFile)).equals(original)).toBe(true);
      expect(refreshed.edges.length).toBe(index.edges.length);
    }
  });

  it("keeps an already loaded index readable after a later publish replaces edges.json", async () => {
    const { refreshWorkspace } = await import("../src/api.js");
    const dir = await scratch(); const cacheDir = path.join(dir, "cache");
    const repo = path.join(dir, "repo");
    await fs.cp(FIXTURE, repo, { recursive: true });
    const built = await buildIndex(repo, { cacheDir });
    const loaded = (await loadIndex(repo, { cacheDir }))!;
    expect((loaded as unknown as { edgesLoaded: () => boolean }).edgesLoaded()).toBe(false);
    await fs.appendFile(path.join(repo, "src", "util.ts"), "\nexport function laterEdge(): number { return compute(1); }\n");
    const refreshed = await refreshWorkspace(repo, { cacheDir });
    expect(refreshed.edges.length).toBeGreaterThan(built.edges.length);
    expect(loaded.edges).toEqual(built.edges);
  });

  it("returns undefined for a pre-bump format 9 extraction identity and rebuilds bytes equal to a full build", async () => {
    const { refreshWorkspace } = await import("../src/api.js");
    const dir = await scratch(); const cacheDir = path.join(dir, "cache"); const fullCache = path.join(dir, "full");
    const repo = path.join(dir, "repo");
    await fs.cp(FIXTURE, repo, { recursive: true });
    const index = await buildIndex(repo, { cacheDir });
    const ws = workspaceDirFor(cacheDir, index.root);
    const corePath = path.join(ws, "index.json");
    const original = (await fs.readFile(corePath)).toString("utf8");
    expect(original).toContain('"structural-9.2.scan-4');
    const stale = Buffer.from(original.replace('"structural-9.2.scan-4', '"structural-9.scan-4'), "utf8");
    expect(stale.toString("utf8")).not.toBe(original);
    await fs.writeFile(corePath, stale);
    await fs.writeFile(path.join(ws, "index.sha"), sha256Hex(stale));
    await expect(loadIndex(repo, { cacheDir })).resolves.toBeUndefined();
    await refreshWorkspace(repo, { cacheDir });
    const full = await buildIndex(repo, { cacheDir: fullCache });
    for (const name of ["index.json", "edges.json", "text.bin"]) {
      const rebuilt = await fs.readFile(path.join(ws, name));
      const expected = await fs.readFile(path.join(workspaceDirFor(fullCache, full.root), name));
      expect(rebuilt.equals(expected), name).toBe(true);
    }
  });

  it("returns undefined for a format 8 core", async () => {
    const dir = await scratch(); const cacheDir = path.join(dir, "cache");
    const index = await buildIndex(FIXTURE, { cacheDir });
    const corePath = path.join(workspaceDirFor(cacheDir, index.root), "index.json");
    const core = JSON.parse((await fs.readFile(corePath)).toString("utf8")) as { formatVersion: number };
    core.formatVersion = 8;
    const raw = Buffer.from(JSON.stringify(core));
    await fs.writeFile(corePath, raw);
    await fs.writeFile(path.join(workspaceDirFor(cacheDir, index.root), "index.sha"), sha256Hex(raw));
    await expect(loadIndex(FIXTURE, { cacheDir })).resolves.toBeUndefined();
  });
});

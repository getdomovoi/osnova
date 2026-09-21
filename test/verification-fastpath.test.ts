import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex, freshness, indexGeneration, loadIndex, refreshWorkspace, serializeArtifact } from "../src/index.js";
import { workspaceDirFor } from "../src/cache/cache.js";
import { inspectFreshness } from "../src/index/incremental.js";
import { loadVerification } from "../src/index/verification.js";
import { knownIndexGeneration } from "../src/index/generation.js";
import { sha256Hex } from "../src/index/scan.js";

let temporary: string;
let workspace: string;
let cacheDir: string;
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-verification-"));
  workspace = path.join(temporary, "workspace"); cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
  for (let index = 0; index < 20; index += 1) await fs.writeFile(path.join(workspace, `file-${index}.ts`), `export function value${index}() { return ${index}; }\n`);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(temporary, { recursive: true, force: true }); });

function sourceReads(): { count: () => number } {
  const read = fs.readFile.bind(fs);
  let count = 0;
  vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
    if (path.resolve(String(args[0])).startsWith(`${path.resolve(workspace)}${path.sep}`)) count += 1;
    return read(...args);
  });
  return { count: () => count };
}

it("uses generation-bound metadata after a full authoritative build", async () => {
  const built = await buildIndex(workspace, { cacheDir });
  expect(knownIndexGeneration(built)).toBe(indexGeneration(built));
  const reads = sourceReads();
  const refreshed = await refreshWorkspace(workspace, { cacheDir });
  expect(reads.count()).toBe(0);
  expect(indexGeneration(refreshed)).toBe(indexGeneration(built));
  const verification = JSON.parse(await fs.readFile(path.join(workspaceDirFor(cacheDir, built.root), "verification.json"), "utf8")) as { generation: string; files: Record<string, unknown> };
  expect(verification.generation).toBe(indexGeneration(built));
  expect(Object.keys(verification.files)).toHaveLength(20);
  expect(serializeArtifact(refreshed)).toEqual(serializeArtifact(built));
});

it("reuses an immutable loaded index while the published artifact identity is unchanged", async () => {
  const first = await refreshWorkspace(workspace, { cacheDir, reuseMemory: true });
  const second = await refreshWorkspace(workspace, { cacheDir, reuseMemory: true });
  expect(second).toBe(first);
  await fs.writeFile(path.join(workspace, "file-0.ts"), "export function changed() { return 0; }\n");
  const changed = await refreshWorkspace(workspace, { cacheDir, reuseMemory: true });
  expect(changed).not.toBe(first);
  expect(await refreshWorkspace(workspace, { cacheDir, reuseMemory: true })).toBe(changed);
});

it("does not reuse a caller-visible index object unless explicitly enabled", async () => {
  const first = await refreshWorkspace(workspace, { cacheDir });
  const second = await refreshWorkspace(workspace, { cacheDir });
  expect(second).not.toBe(first);
  expect(indexGeneration(second)).toBe(indexGeneration(first));
});

it("invalidates in-memory data when another process could have published the artifact", async () => {
  const first = await refreshWorkspace(workspace, { cacheDir, reuseMemory: true });
  const artifact = path.join(workspaceDirFor(cacheDir, first.root), "index.json");
  const future = new Date(Date.now() + 5_000);
  await fs.utimes(artifact, future, future);
  const reloaded = await refreshWorkspace(workspace, { cacheDir, reuseMemory: true });
  expect(reloaded).not.toBe(first);
  expect(indexGeneration(reloaded)).toBe(indexGeneration(first));
});

it("does not hide externally corrupted or deleted artifacts behind memory", async () => {
  const first = await refreshWorkspace(workspace, { cacheDir, reuseMemory: true });
  const dir = workspaceDirFor(cacheDir, first.root);
  const artifact = path.join(dir, "index.json");
  await fs.writeFile(artifact, "corrupt");
  const rebuiltAfterCorruption = await refreshWorkspace(workspace, { cacheDir, reuseMemory: true });
  expect(rebuiltAfterCorruption).not.toBe(first);
  expect(indexGeneration(rebuiltAfterCorruption)).toBe(indexGeneration(first));
  const raw = await fs.readFile(artifact);
  const sha = (await fs.readFile(path.join(dir, "index.sha"), "utf8")).trim();
  expect(sha).toBe(sha256Hex(raw));
  await fs.rm(artifact);
  const rebuilt = await refreshWorkspace(workspace, { cacheDir, reuseMemory: true });
  expect(indexGeneration(rebuilt)).toBe(indexGeneration(first));
  expect(rebuilt).not.toBe(first);
});

it("recovers generation identity from exact persisted artifact bytes", async () => {
  const built = await buildIndex(workspace, { cacheDir });
  const loaded = await (await import("../src/index/serialize.js")).loadArtifact(built.root, cacheDir);
  expect(loaded).toBeDefined();
  expect(knownIndexGeneration(loaded!)).toBe(indexGeneration(built));
  expect(indexGeneration(loaded!)).toBe(indexGeneration(built));
});

it("keeps public freshness hash-authoritative", async () => {
  const built = await buildIndex(workspace, { cacheDir });
  expect(await freshness(built, workspace)).toEqual({ added: [], changed: [], deleted: [] });
  expect((await inspectFreshness(built, workspace)).hashedFiles).toBe(20);
});

it("falls back to hashing when the sidecar is corrupt or from another generation", async () => {
  const built = await buildIndex(workspace, { cacheDir });
  const verification = path.join(workspaceDirFor(cacheDir, built.root), "verification.json");
  await fs.writeFile(verification, "not json");
  expect(await loadVerification(cacheDir, built.root, indexGeneration(built))).toBeUndefined();
  expect((await inspectFreshness(built, workspace)).hashedFiles).toBe(20);
  await refreshWorkspace(workspace, { cacheDir });
  const state = JSON.parse(await fs.readFile(verification, "utf8")) as { generation: string; checksum: string };
  await fs.writeFile(verification, JSON.stringify({ ...state, generation: "0".repeat(64) }));
  expect(await loadVerification(cacheDir, built.root, indexGeneration(built))).toBeUndefined();
  await refreshWorkspace(workspace, { cacheDir });
});

it.each(["null", "[]", "1", "\"text\""])("ignores valid JSON with an invalid sidecar shape: %s", async (content) => {
  const built = await buildIndex(workspace, { cacheDir });
  const verification = path.join(workspaceDirFor(cacheDir, built.root), "verification.json");
  await fs.writeFile(verification, content);
  expect(await loadVerification(cacheDir, built.root, indexGeneration(built))).toBeUndefined();
  expect((await inspectFreshness(built, workspace)).hashedFiles).toBe(20);
});

it("hashes metadata changes but does not change generation for a touch", async () => {
  const built = await buildIndex(workspace, { cacheDir });
  const file = path.join(workspace, "file-0.ts");
  const future = new Date(Date.now() + 5_000);
  await fs.utimes(file, future, future);
  const verified = await loadVerification(cacheDir, built.root, indexGeneration(built));
  expect((await inspectFreshness(built, workspace, verified?.files)).hashedFiles).toBe(1);
  const refreshed = await refreshWorkspace(workspace, { cacheDir });
  expect(indexGeneration(refreshed)).toBe(indexGeneration(built));
});

it("detects same-size content changes even when mtime is restored", async () => {
  const built = await buildIndex(workspace, { cacheDir });
  const file = path.join(workspace, "file-0.ts");
  const stat = await fs.stat(file);
  const original = await fs.readFile(file, "utf8");
  const changed = original.replace("return 0", "return 9");
  expect(changed.length).toBe(original.length);
  await fs.writeFile(file, changed);
  await fs.utimes(file, stat.atime, stat.mtime);
  const refreshed = await refreshWorkspace(workspace, { cacheDir });
  expect(indexGeneration(refreshed)).not.toBe(indexGeneration(built));
  expect(refreshed.files.get("file-0.ts")?.text).toBe(changed);
});

it("does not rehash every unchanged file during an edited refresh", async () => {
  const built = await buildIndex(workspace, { cacheDir });
  await fs.writeFile(path.join(workspace, "file-0.ts"), "export function changed() { return 0; }\n");
  const reads = sourceReads();
  const refreshed = await refreshWorkspace(workspace, { cacheDir });
  expect(reads.count()).toBeLessThanOrEqual(2);
  expect(refreshed.symbols.has("file-0.ts#changed")).toBe(true);
  expect(serializeArtifact(refreshed)).toEqual(serializeArtifact(await buildIndex(workspace, { cacheDir: path.join(temporary, "full-cache") })));
  expect(indexGeneration(refreshed)).not.toBe(indexGeneration(built));
});

it("leaves the verification sidecar untouched on an unchanged refresh", async () => {
  const built = await buildIndex(workspace, { cacheDir });
  const verification = path.join(workspaceDirFor(cacheDir, built.root), "verification.json");
  const before = await fs.stat(verification, { bigint: true });
  const content = await fs.readFile(verification, "utf8");
  await refreshWorkspace(workspace, { cacheDir });
  const after = await fs.stat(verification, { bigint: true });
  expect([after.ino, after.mtimeNs, after.size]).toEqual([before.ino, before.mtimeNs, before.size]);
  expect(await fs.readFile(verification, "utf8")).toBe(content);
  await fs.writeFile(path.join(workspace, "file-0.ts"), "export function changed() { return 0; }\n");
  await refreshWorkspace(workspace, { cacheDir });
  expect(await fs.readFile(verification, "utf8")).not.toBe(content);
});

it("defers the core body until first use and keeps the generation from the verified checksum", async () => {
  const built = await buildIndex(workspace, { cacheDir });
  const loaded = (await loadIndex(workspace, { cacheDir }))!;
  expect(knownIndexGeneration(loaded)).toBe(indexGeneration(built));
  expect(loaded.root).toBe(built.root);
  expect(loaded.files.size).toBe(20);
  expect(loaded.symbols.has("file-3.ts#value3")).toBe(true);
  expect(serializeArtifact(loaded)).toEqual(serializeArtifact(built));
});

it("rejects a same-size tamper past the envelope before the body is ever read", async () => {
  const built = await buildIndex(workspace, { cacheDir });
  const dir = workspaceDirFor(cacheDir, built.root);
  const core = path.join(dir, "index.json");
  const original = await fs.readFile(core);
  const offset = original.indexOf(Buffer.from('"kind":"function"', "utf8"), original.indexOf(',"files":['));
  expect(offset).toBeGreaterThan(0);
  const tampered = Buffer.from(original);
  tampered.write("g", offset + '"kind":"'.length, "utf8");
  expect(tampered.length).toBe(original.length);
  await fs.writeFile(core, tampered);
  await expect(loadIndex(workspace, { cacheDir })).rejects.toMatchObject({ diagnostic: { code: "cache-read-failed" } });
  const refreshed = await refreshWorkspace(workspace, { cacheDir });
  expect(indexGeneration(refreshed)).toBe(indexGeneration(built));
  expect((await fs.readFile(core)).equals(original)).toBe(true);
});

it("reports a checksum-valid but structurally corrupt body as cache-read-failed on first use", async () => {
  const built = await buildIndex(workspace, { cacheDir });
  const dir = workspaceDirFor(cacheDir, built.root);
  const core = path.join(dir, "index.json");
  const parsed = JSON.parse(await fs.readFile(core, "utf8")) as { files: Array<{ symbols: Array<{ span: { e: number } }> }> };
  parsed.files[0]!.symbols[0]!.span.e = 0;
  const raw = Buffer.from(JSON.stringify(parsed), "utf8");
  await fs.writeFile(core, raw);
  await fs.writeFile(path.join(dir, "index.sha"), `${sha256Hex(raw)}\n`);
  const loaded = (await loadIndex(workspace, { cacheDir }))!;
  expect(loaded.root).toBe(built.root);
  expect(() => loaded.files).toThrow(/cache-read-failed/);
  expect(() => loaded.edges).toThrow(/cache-read-failed/);
});

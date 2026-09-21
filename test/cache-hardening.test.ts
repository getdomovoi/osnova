import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { deserializeArtifact, loadArtifact, serializeArtifact, serializeSections } from "../src/index/serialize.js";
import { evictLru, workspaceDirFor } from "../src/cache/cache.js";
import { refreshWorkspace } from "../src/api.js";
import { gzipSync } from "node:zlib";
import { sha256Hex } from "../src/index/scan.js";
import { holdsCacheLock, withCacheLock } from "../src/cache/lock.js";

const temporary: string[] = [];
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-cache-hardening-"));
  temporary.push(dir);
  const root = path.join(dir, "root");
  const cacheDir = path.join(dir, "cache");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
  return { root, cacheDir, dir };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it("does not retain reentrant ownership in an escaped async callback", async () => {
  const { dir } = await fixture();
  const lock = path.join(dir, "ownership.lock");
  let resume: () => void = () => {};
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  let escaped: Promise<boolean> | undefined;
  await withCacheLock(lock, async () => {
    expect(holdsCacheLock(lock)).toBe(true);
    escaped = (async () => { await gate; return holdsCacheLock(lock); })();
  });
  resume();
  expect(await escaped).toBe(false);
});

it("rejects cache artifacts from a different workspace", async () => {
  const { root, cacheDir } = await fixture();
  const index = await buildIndex(root, { cacheDir });
  const data = JSON.parse(serializeArtifact(index).toString()) as { root: string };
  data.root = path.dirname(index.root);
  const raw = Buffer.from(JSON.stringify(data));
  await fs.writeFile(path.join(workspaceDirFor(cacheDir, root), "index.json"), raw);
  await fs.writeFile(path.join(workspaceDirFor(cacheDir, root), "index.sha"), `${sha256Hex(raw)}\n`);
  const error: unknown = await loadArtifact(root, cacheDir).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ diagnostic: { code: "cache-read-failed" } });
  expect((error as { cause?: Error }).cause?.message).toMatch(/different workspace/);
});

it("rejects altered cached source even when the envelope checksum was recomputed", async () => {
  const { root, cacheDir } = await fixture();
  await buildIndex(root, { cacheDir });
  const textPath = path.join(workspaceDirFor(cacheDir, root), "text.bin");
  await fs.appendFile(textPath, "x");
  await expect(loadArtifact(root, cacheDir)).rejects.toThrow(/cache-read-failed/);
});

it("round-trips non-UTF8 input as an explicitly non-text fallback card", async () => {
  const { root, cacheDir } = await fixture();
  await fs.writeFile(path.join(root, "encoded.ts"), Buffer.from([255, 254, 1]));
  const index = await buildIndex(root, { cacheDir });
  expect(index.files.get("encoded.ts")).toMatchObject({ language: "fallback", text: "", lineCount: 0, symbols: [] });
  expect((await loadArtifact(index.root, cacheDir))?.files.get("encoded.ts")).toEqual(index.files.get("encoded.ts"));
});

it.each(["../escape.ts", "/absolute.ts", "a/../a.ts", "a\\b.ts"])("rejects unsafe cached path %s", async (file) => {
  const { root, cacheDir } = await fixture();
  const data = JSON.parse(serializeArtifact(await buildIndex(root, { cacheDir })).toString()) as { paths: string[] };
  data.paths[0] = file;
  expect(() => deserializeArtifact(JSON.stringify(data), undefined)).toThrow(/corrupt/);
});

it("invalidates mismatched extraction inputs", async () => {
  const { root, cacheDir } = await fixture();
  const data = JSON.parse(serializeArtifact(await buildIndex(root, { cacheDir })).toString()) as Record<string, unknown>;
  data.extractionVersion = "obsolete";
  const raw = Buffer.from(JSON.stringify(data));
  await fs.writeFile(path.join(workspaceDirFor(cacheDir, root), "index.json"), raw);
  await fs.writeFile(path.join(workspaceDirFor(cacheDir, root), "index.sha"), `${sha256Hex(raw)}\n`);
  expect(await loadArtifact(root, cacheDir)).toBeUndefined();
});

it("evicts by reads rather than publication age and enforces artifact bytes", async () => {
  const { root, cacheDir, dir } = await fixture();
  const roots = [root, path.join(dir, "second"), path.join(dir, "third")];
  for (const workspace of roots) {
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "a.ts"), "export const a = 1;\n");
    await buildIndex(workspace, { cacheDir });
  }
  await loadArtifact(root, cacheDir);
  await evictLru(cacheDir, 2);
  expect(await loadArtifact(root, cacheDir)).toBeDefined();
  expect(await loadArtifact(roots[1]!, cacheDir)).toBeUndefined();
  await evictLru(cacheDir, { maxWorkspaces: 8, maxBytes: 1 });
  expect(await loadArtifact(root, cacheDir)).toBeUndefined();
  expect(await loadArtifact(roots[2]!, cacheDir)).toBeUndefined();
});

it.each(["files", "edgesIdentity", "symbols", "span", "hash", "duplicate", "edgeTarget"])("rejects malformed %s without returning empty data", async (field) => {
  const { root, cacheDir } = await fixture();
  await fs.writeFile(path.join(root, "a.ts"), "export function a() {}\na();\n");
  const index = await buildIndex(root, { cacheDir });
  const sections = serializeSections(index);
  const data = JSON.parse(sections.core.toString()) as {
    files: Array<Record<string, unknown>>; edgesHash: string; edgesBytes: number;
  };
  const file = data.files[0]!;
  let edgeBytes: Buffer | undefined = sections.edges.bytes;
  if (field === "files") Object.assign(data, { files: null });
  if (field === "edgesIdentity") Object.assign(data, { edgesHash: "z".repeat(64) });
  if (field === "symbols") file.symbols = null;
  if (field === "span") (file.symbols as Record<string, unknown>[])[0]!.span = { s: -1, e: 0, sc: 0, ec: 0 };
  if (field === "hash") file.hash = "bad";
  if (field === "duplicate") data.files.push(file);
  if (field === "edgeTarget") {
    const lines = sections.edges.bytes.toString("utf8").slice(0, -1).split("\n");
    const tuple = JSON.parse(lines[1]!) as unknown[];
    tuple[6] = 999;
    lines[1] = JSON.stringify(tuple);
    edgeBytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    Object.assign(data, { edgesHash: sha256Hex(edgeBytes), edgesBytes: edgeBytes.length });
  }
  expect(() => deserializeArtifact(JSON.stringify(data), undefined, sections.text.bytes, edgeBytes)).toThrow(/corrupt/);
});

it("rejects corrupt compressed artifacts and preserves a valid cache when a smaller cap is requested", async () => {
  const { root, cacheDir } = await fixture();
  const index = await refreshWorkspace(root, { cacheDir });
  await expect(refreshWorkspace(root, { cacheDir, maxBytes: 1 })).rejects.toThrow(/cache-limit-exceeded/);
  expect((await loadArtifact(root, cacheDir))?.files.size).toBe(1);
  const target = path.join(workspaceDirFor(cacheDir, root), "index.json");
  await fs.writeFile(target, gzipSync(serializeArtifact(index)).subarray(0, 20));
  await expect(refreshWorkspace(root, { cacheDir })).rejects.toThrow(/cache-read-failed/);
});

it("publishes compressed and plain generations through one atomic artifact path", async () => {
  const { root, cacheDir } = await fixture();
  const declarations = Array.from({ length: 7000 }, (_, i) => `export const x${i} = ${i};`).join("\n");
  for (let i = 0; i < 6; i += 1) await fs.writeFile(path.join(root, `${i}.ts`), `${declarations}\n`);
  const large = await refreshWorkspace(root, { cacheDir });
  const target = path.join(workspaceDirFor(cacheDir, root), "index.json");
  const compressed = await fs.readFile(target);
  expect([...compressed.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
  expect(compressed[8]).toBe(4);
  expect(serializeArtifact((await loadArtifact(root, cacheDir))!).toString()).toBe(serializeArtifact(large).toString());
  for (let i = 0; i < 6; i += 1) await fs.unlink(path.join(root, `${i}.ts`));
  const small = await refreshWorkspace(root, { cacheDir });
  expect((await fs.readFile(target)).toString()).toBe(serializeArtifact(small).toString());
  expect((await fs.readdir(path.dirname(target))).sort()).toEqual(["access", "edges.json", "family.json", "index.json", "index.sha", "text.bin", "verification.json"]);
});

it("reports an unwritable cache target explicitly", async () => {
  const { root, cacheDir } = await fixture();
  await fs.writeFile(cacheDir, "not a directory");
  await expect(refreshWorkspace(root, { cacheDir })).rejects.toThrow(/cache-write-failed/);
});

it("evicts only owned artifacts while preserving unrelated workspace sidecars", async () => {
  const { root, cacheDir } = await fixture();
  await buildIndex(root, { cacheDir });
  const dir = workspaceDirFor(cacheDir, root);
  await fs.mkdir(path.join(dir, "other"));
  await fs.writeFile(path.join(dir, "other/keep"), "preserve");
  await evictLru(cacheDir, { maxBytes: 0 });
  expect(await loadArtifact(root, cacheDir)).toBeUndefined();
  expect(await fs.readFile(path.join(dir, "other/keep"), "utf8")).toBe("preserve");
});

it("does not disguise access-sidecar write failure as a missing artifact", async () => {
  const { root, cacheDir } = await fixture();
  await buildIndex(root, { cacheDir });
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to).endsWith(`${path.sep}access`)) throw Object.assign(new Error("fixture missing access target"), { code: "ENOENT" });
    return rename(from, to);
  });
  await expect(loadArtifact(root, cacheDir)).rejects.toThrow(/cache/);
});

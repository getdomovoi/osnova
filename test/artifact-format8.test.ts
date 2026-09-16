import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { serializeText, lazyTextCard, readTextSlice } from "../src/index/textStore.js";
import { sha256Hex } from "../src/index/scan.js";
import { serializeArtifact, serializeSections, deserializeArtifact, serializedTextIdentity } from "../src/index/serialize.js";
import { loadIndex, refreshWorkspace } from "../src/api.js";
import { workspaceDirFor } from "../src/cache/cache.js";
import { indexGeneration } from "../src/api.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-repo");
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-fmt8-"));
  dirs.push(dir);
  return dir;
}

describe("text sidecar", () => {
  it("lays out every card's text in path order with exact byte offsets", async () => {
    const index = await buildIndex(FIXTURE);
    const layout = serializeText(index);
    const paths = [...index.files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let cursor = 0;
    for (const file of paths) {
      const card = index.files.get(file)!;
      const [offset, length] = layout.offsets.get(file)!;
      expect(offset).toBe(cursor);
      expect(length).toBe(Buffer.byteLength(card.text));
      expect(layout.bytes.subarray(offset, offset + length).toString("utf8")).toBe(card.text);
      cursor += length;
    }
    expect(layout.bytes.length).toBe(cursor);
    expect(layout.hash).toBe(sha256Hex(layout.bytes));
  });

  it("reads a slice lazily once and caches it", async () => {
    const index = await buildIndex(FIXTURE);
    const layout = serializeText(index);
    const dir = await scratch();
    const textPath = path.join(dir, "text.bin");
    await fs.writeFile(textPath, layout.bytes);
    const source = index.files.get("src/util.ts")!;
    const [offset, length] = layout.offsets.get("src/util.ts")!;
    const { text: _drop, ...rest } = source;
    const card = lazyTextCard(rest, textPath, offset, length, source.hash, layout.hash, layout.bytes.length);
    expect(card.text).toBe(source.text);
    await fs.rm(textPath);
    expect(card.text).toBe(source.text);
  });

  it("fails closed on a short read or hash mismatch", async () => {
    const index = await buildIndex(FIXTURE);
    const layout = serializeText(index);
    const dir = await scratch();
    const textPath = path.join(dir, "text.bin");
    await fs.writeFile(textPath, layout.bytes.subarray(0, 8));
    const source = index.files.get("src/util.ts")!;
    const [offset, length] = layout.offsets.get("src/util.ts")!;
    const { text: _drop, ...rest } = source;
    const card = lazyTextCard(rest, textPath, offset, length, source.hash, layout.hash, layout.bytes.length);
    expect(() => card.text).toThrow(/cache-read-failed/);
    await fs.writeFile(textPath, layout.bytes);
    const wrongHash = lazyTextCard(rest, textPath, offset, length, "0".repeat(64), layout.hash, layout.bytes.length);
    expect(() => wrongHash.text).toThrow(/cache-read-failed/);
    expect(readTextSlice(textPath, offset, length)).toBe(source.text);
  });
});

describe("format 9 core envelope", () => {
  it("carries text identity and offsets instead of text", async () => {
    const index = await buildIndex(FIXTURE);
    const core = serializeArtifact(index);
    const parsed = JSON.parse(core.toString("utf8")) as { formatVersion: number; textHash: string; textBytes: number; paths: string[]; files: Array<{ p: number; text?: unknown; to: number; tl: number }> };
    const layout = serializeText(index);
    expect(parsed.formatVersion).toBe(9);
    expect(parsed.textHash).toBe(layout.hash);
    expect(parsed.textBytes).toBe(layout.bytes.length);
    for (const file of parsed.files) {
      expect(file.text).toBeUndefined();
      expect([file.to, file.tl]).toEqual(layout.offsets.get(parsed.paths[file.p]!));
    }
    expect(serializedTextIdentity(core.toString("utf8"))).toEqual({ hash: layout.hash, bytes: layout.bytes.length });
  });

  it("round-trips through a text file and re-serializes to identical core bytes", async () => {
    const index = await buildIndex(FIXTURE);
    const sections = serializeSections(index);
    const dir = await scratch();
    const textPath = path.join(dir, "text.bin");
    await fs.writeFile(textPath, sections.text.bytes);
    const loaded = deserializeArtifact(sections.core.toString("utf8"), textPath, undefined, sections.edges.bytes);
    expect(loaded.files.get("src/util.ts")!.text).toBe(index.files.get("src/util.ts")!.text);
    expect(serializeArtifact(loaded).equals(sections.core)).toBe(true);
    expect(serializeText(loaded).bytes.equals(sections.text.bytes)).toBe(true);
  });

  it("rejects offsets that run past the declared text length", async () => {
    const index = await buildIndex(FIXTURE);
    const core = JSON.parse(serializeArtifact(index).toString("utf8")) as { textBytes: number; files: Array<{ to: number; tl: number }>; root: string };
    core.files[0]!.tl = core.textBytes + 1;
    expect(() => deserializeArtifact(JSON.stringify(core), undefined, serializeText(index).bytes)).toThrow(/corrupt/);
  });
});

describe("format 9 publication", () => {
  it("writes text.bin and index.json and loads them lazily", async () => {
    const dir = await scratch();
    const cacheDir = path.join(dir, "cache");
    const index = await buildIndex(FIXTURE, { cacheDir });
    const workspace = workspaceDirFor(cacheDir, index.root);
    const names = (await fs.readdir(workspace)).sort();
    expect(names).toContain("index.json");
    expect(names).toContain("text.bin");
    const loaded = await loadIndex(FIXTURE, { cacheDir });
    expect(loaded).toBeDefined();
    expect(indexGeneration(loaded!)).toBe(indexGeneration(index));
    expect(loaded!.files.get("src/util.ts")!.text).toBe(index.files.get("src/util.ts")!.text);
  });

  it("parses the core artifact JSON exactly once per loadIndex", async () => {
    const dir = await scratch();
    const cacheDir = path.join(dir, "cache");
    await buildIndex(FIXTURE, { cacheDir });
    const originalParse = JSON.parse;
    let coreParses = 0;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (typeof text === "string" && text.includes('"formatVersion"')) coreParses += 1;
      return originalParse(text, reviver);
    });
    try {
      const loaded = await loadIndex(FIXTURE, { cacheDir });
      expect(loaded).toBeDefined();
    } finally {
      spy.mockRestore();
    }
    expect(coreParses).toBe(1);
  });

  it("treats a missing or mismatched text.bin as a corrupt cache", async () => {
    const dir = await scratch();
    const cacheDir = path.join(dir, "cache");
    const index = await buildIndex(FIXTURE, { cacheDir });
    const textPath = path.join(workspaceDirFor(cacheDir, index.root), "text.bin");
    await fs.appendFile(textPath, "x");
    await expect(loadIndex(FIXTURE, { cacheDir })).rejects.toMatchObject({ diagnostic: { code: "cache-read-failed" } });
    await fs.rm(textPath);
    await expect(loadIndex(FIXTURE, { cacheDir })).rejects.toMatchObject({ diagnostic: { code: "cache-read-failed" } });
  });

  it("returns undefined for a format 7 artifact", async () => {
    const dir = await scratch();
    const cacheDir = path.join(dir, "cache");
    const index = await buildIndex(FIXTURE, { cacheDir });
    const corePath = path.join(workspaceDirFor(cacheDir, index.root), "index.json");
    const core = JSON.parse((await fs.readFile(corePath)).toString("utf8")) as { formatVersion: number };
    core.formatVersion = 7;
    const raw = Buffer.from(JSON.stringify(core));
    await fs.writeFile(corePath, raw);
    await fs.writeFile(path.join(workspaceDirFor(cacheDir, index.root), "index.sha"), `${sha256Hex(raw)}\n`);
    await expect(loadIndex(FIXTURE, { cacheDir })).resolves.toBeUndefined();
  });
});

describe("format 9 self-heal", () => {
  it("lets refreshWorkspace rebuild past a mismatched or missing text.bin that loadIndex still rejects", async () => {
    const dir = await scratch();
    const cacheDir = path.join(dir, "cache");
    const index = await buildIndex(FIXTURE, { cacheDir });
    const workspace = workspaceDirFor(cacheDir, index.root);
    const textPath = path.join(workspace, "text.bin");
    const corePath = path.join(workspace, "index.json");

    await fs.appendFile(textPath, "x");
    await expect(loadIndex(FIXTURE, { cacheDir })).rejects.toMatchObject({ diagnostic: { code: "cache-read-failed" } });
    const refreshedAfterMismatch = await refreshWorkspace(FIXTURE, { cacheDir });
    const loadedAfterMismatch = await loadIndex(FIXTURE, { cacheDir });
    expect(loadedAfterMismatch).toBeDefined();
    expect(indexGeneration(loadedAfterMismatch!)).toBe(indexGeneration(refreshedAfterMismatch));
    const identityAfterMismatch = serializedTextIdentity((await fs.readFile(corePath)).toString("utf8"));
    expect((await fs.stat(textPath)).size).toBe(identityAfterMismatch.bytes);

    await fs.rm(textPath);
    await expect(loadIndex(FIXTURE, { cacheDir })).rejects.toMatchObject({ diagnostic: { code: "cache-read-failed" } });
    const refreshedAfterDeletion = await refreshWorkspace(FIXTURE, { cacheDir });
    const loadedAfterDeletion = await loadIndex(FIXTURE, { cacheDir });
    expect(loadedAfterDeletion).toBeDefined();
    expect(indexGeneration(loadedAfterDeletion!)).toBe(indexGeneration(refreshedAfterDeletion));
    const identityAfterDeletion = serializedTextIdentity((await fs.readFile(corePath)).toString("utf8"));
    expect((await fs.stat(textPath)).size).toBe(identityAfterDeletion.bytes);
  });
});

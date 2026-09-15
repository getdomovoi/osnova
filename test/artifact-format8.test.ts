import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { serializeText, lazyTextCard, readTextSlice } from "../src/index/textStore.js";
import { sha256Hex } from "../src/index/scan.js";

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
    const card = lazyTextCard(rest, textPath, offset, length, source.hash);
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
    const card = lazyTextCard(rest, textPath, offset, length, source.hash);
    expect(() => card.text).toThrow(/cache-read-failed/);
    await fs.writeFile(textPath, layout.bytes);
    const wrongHash = lazyTextCard(rest, textPath, offset, length, "0".repeat(64));
    expect(() => wrongHash.text).toThrow(/cache-read-failed/);
    expect(readTextSlice(textPath, offset, length)).toBe(source.text);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { loadIndex, refreshWorkspace } from "../src/api.js";
import { serializeSections } from "../src/index/serialize.js";
import { workspaceDirFor } from "../src/cache/cache.js";
import { serializeEdges, deserializeEdges, edgeKinds } from "../src/index/edgeStore.js";
import { sha256Hex } from "../src/index/scan.js";
import type { OsnovaEdge } from "../src/types.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-repo");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("edge store", () => {
  it("round-trips every edge through integer tuples", async () => {
    const index = await buildIndex(FIXTURE);
    const paths = [...index.files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const layout = serializeEdges(index.edges, paths);
    expect(layout.count).toBe(index.edges.length);
    expect(layout.hash).toBe(sha256Hex(layout.bytes));
    const back = deserializeEdges(layout.bytes, paths, index.files);
    expect(back).toEqual(index.edges);
    const again = serializeEdges(back, paths);
    expect(again.bytes.equals(layout.bytes)).toBe(true);
  });

  it("writes one header line and one line per edge, grouped by source file", async () => {
    const index = await buildIndex(FIXTURE);
    const paths = [...index.files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const lines = serializeEdges(index.edges, paths).bytes.toString("utf8").split("\n");
    expect(lines.at(-1)).toBe("");
    const header = JSON.parse(lines[0]!) as { formatVersion: number; count: number; evidence: unknown[]; bindings: unknown[] };
    expect(header.formatVersion).toBe(11);
    expect(header.count).toBe(index.edges.length);
    expect(lines.length - 2).toBe(index.edges.length);
    const fileIndexes = lines.slice(1, -1).map((line) => (JSON.parse(line) as number[])[1]!);
    expect([...fileIndexes]).toEqual([...fileIndexes].sort((a, b) => a - b));
    expect(edgeKinds).toEqual(["calls", "references", "imports", "extends", "routes"]);
  });

  it("keeps the interned tables byte-identical across a lazy reload and an unrelated incremental edit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-intern-")); dirs.push(dir);
    const repo = path.join(dir, "repo"); const cacheDir = path.join(dir, "cache");
    await fs.mkdir(repo);
    await fs.writeFile(path.join(repo, "a.ts"), "class A {}\nclass Z {}\nfunction caller() { Z.send(); const x = new A(); x.send(); }\n");
    await fs.writeFile(path.join(repo, "b.ts"), "export const b = 1;\n");
    const built = await buildIndex(repo, { cacheDir });
    const fresh = serializeSections(built);
    const reloaded = await loadIndex(repo, { cacheDir });
    expect(reloaded).toBeDefined();
    const roundTrip = serializeSections(reloaded!);
    expect(roundTrip.edges.bytes.equals(fresh.edges.bytes)).toBe(true);
    expect(roundTrip.core.equals(fresh.core)).toBe(true);
    expect(roundTrip.text.bytes.equals(fresh.text.bytes)).toBe(true);
    const onDisk = async (name: string): Promise<Buffer> => {
      const raw = await fs.readFile(path.join(workspaceDirFor(cacheDir, repo), name));
      return raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
    };
    expect(roundTrip.core.equals(await onDisk("index.json"))).toBe(true);
    expect(roundTrip.edges.bytes.equals(await onDisk("edges.json"))).toBe(true);
    expect(roundTrip.text.bytes.equals(await onDisk("text.bin"))).toBe(true);
    await fs.appendFile(path.join(repo, "b.ts"), "export const c = 2;\n");
    await refreshWorkspace(repo, { cacheDir });
    const fullCache = path.join(dir, "full");
    await buildIndex(repo, { cacheDir: fullCache });
    for (const name of ["index.json", "edges.json", "text.bin"]) {
      const incremental = await fs.readFile(path.join(workspaceDirFor(cacheDir, repo), name));
      const full = await fs.readFile(path.join(workspaceDirFor(fullCache, repo), name));
      expect(incremental.equals(full), name).toBe(true);
    }
  });

  it("serializes content-identical evidence and bindings to the same bytes whatever the property insertion order", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-order-")); dirs.push(dir);
    const repo = path.join(dir, "repo");
    await fs.mkdir(repo);
    await fs.writeFile(path.join(repo, "a.ts"), "export class A { run() { return 1; } }\nexport function alpha() { return 1; }\nalpha();\n");
    await fs.writeFile(path.join(repo, "b.ts"), "import { A, alpha } from \"./a\";\nexport function beta() { const x = new A(); return x.run() + alpha(); }\n");
    const index = await buildIndex(repo, { cacheDir: path.join(dir, "cache") });
    const paths = [...index.files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const reverse = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverse)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([key, item]) => [key, reverse(item)]))
          : value;
    const reversed = index.edges.map((edge) => reverse(edge) as OsnovaEdge);
    expect(reversed.some((edge) => edge.binding !== undefined && Object.keys(edge.binding).length > 1)).toBe(true);
    expect(reversed.some((edge) => edge.evidence !== undefined && Object.keys(edge.evidence).length > 1)).toBe(true);
    const first = serializeEdges(index.edges, paths);
    const second = serializeEdges(reversed, paths);
    expect(second.bytes.equals(first.bytes)).toBe(true);
    expect(second.hash).toBe(first.hash);
  });

  it("refuses to serialize an unknown edge kind", async () => {
    const index = await buildIndex(FIXTURE);
    const paths = [...index.files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const first = index.edges[0]!;
    expect(() => serializeEdges([{ ...first, kind: "invokes" as OsnovaEdge["kind"] }], paths)).toThrow(/unknown edge kind/);
  });

  it("rejects tuples that point outside the tables", async () => {
    const index = await buildIndex(FIXTURE);
    const paths = [...index.files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const lines = serializeEdges(index.edges, paths).bytes.toString("utf8").split("\n");
    const bad = JSON.parse(lines[1]!) as number[];
    bad[1] = paths.length + 5;
    lines[1] = JSON.stringify(bad);
    expect(() => deserializeEdges(Buffer.from(lines.join("\n")), paths, index.files)).toThrow(/corrupt edge/);
  });
});

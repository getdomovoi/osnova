import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { loadIndex, refreshWorkspace } from "../src/api.js";
import { serializeSections } from "../src/index/serialize.js";
import { workspaceDirFor } from "../src/cache/cache.js";
import { canonical, serializeEdges, deserializeEdges, edgeKinds } from "../src/index/edgeStore.js";
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
    expect(header.formatVersion).toBe(13);
    expect(header.count).toBe(index.edges.length);
    expect(lines.length - 2).toBe(index.edges.length);
    const fileIndexes = lines.slice(1, -1).map((line) => (JSON.parse(line) as number[])[1]!);
    expect([...fileIndexes]).toEqual([...fileIndexes].sort((a, b) => a - b));
    expect(edgeKinds).toEqual(["calls", "references", "imports", "extends", "routes", "implements"]);
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

  it("encodes a shared evidence or binding object once however many edges carry it, to the same bytes as distinct copies", async () => {
    const index = await buildIndex(FIXTURE);
    const paths = [...index.files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const base = index.edges.find((edge) => edge.evidence !== undefined && edge.binding !== undefined)!;
    expect(base).toBeDefined();
    let reads = 0;
    const counted = <T extends object>(value: T): T => new Proxy(value, {
      get(target, key, receiver) { reads += 1; return Reflect.get(target, key, receiver) as unknown; },
    });
    const evidence = counted(base.evidence!);
    const binding = counted(base.binding!);
    const shared: OsnovaEdge[] = Array.from({ length: 400 }, () => ({ ...base, evidence, binding }));
    const copies: OsnovaEdge[] = shared.map(() => ({ ...base, evidence: structuredClone(base.evidence!), binding: structuredClone(base.binding!) }));
    reads = 0;
    const layout = serializeEdges(shared, paths);
    expect(reads).toBeLessThan(40);
    expect(layout.bytes.equals(serializeEdges(copies, paths).bytes)).toBe(true);
  });

  it("serializes shared, equal and reordered copies of the same tables to the bytes of fresh distinct objects", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-mixed-")); dirs.push(dir);
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
    const distinct = index.edges.map((edge) => structuredClone(edge));
    const mixed = index.edges.flatMap((edge) => [
      edge,
      { ...edge, evidence: structuredClone(edge.evidence), binding: structuredClone(edge.binding) },
      reverse(edge) as OsnovaEdge,
    ]);
    const tripled = distinct.flatMap((edge) => [edge, structuredClone(edge), structuredClone(edge)]);
    expect(mixed.some((edge) => edge.binding !== undefined && Object.keys(edge.binding).length > 1)).toBe(true);
    expect(serializeEdges(mixed, paths).bytes.equals(serializeEdges(tripled, paths).bytes)).toBe(true);
  });

  it("keeps JSON-equal table values with different canonical encodings apart", async () => {
    const index = await buildIndex(FIXTURE);
    const paths = [...index.files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const base = index.edges.find((edge) => edge.binding !== undefined)!;
    expect(base).toBeDefined();
    const withExtra = (extra: unknown): OsnovaEdge => ({ ...base, binding: { ...base.binding!, extra } as unknown as OsnovaEdge["binding"] });
    const readSecondOnly = (): object => {
      let reads = 0;
      return Object.defineProperty({}, "a", { enumerable: true, get: () => (++reads === 2 ? 1 : 2) });
    };
    const cases: [string, () => unknown, unknown][] = [
      ["a boxed primitive", () => new Number(1), 1],
      ["an object with a non-enumerable toJSON hook", () => Object.defineProperty({}, "toJSON", { value: () => new Number(1) }), 1],
      ["an array with a non-enumerable toJSON hook", () => Object.defineProperty([], "toJSON", { value: () => new Number(1) }), 1],
      ["an object with an accessor property", readSecondOnly, { a: 1 }],
    ];
    for (const [label, hostile, plainValue] of cases) {
      expect(canonical(hostile()), label).not.toBe(canonical(plainValue));
      if (label !== "an object with an accessor property") expect(JSON.stringify(hostile()), label).toBe(JSON.stringify(plainValue));
      const plainOnly = serializeEdges([withExtra(plainValue)], paths);
      for (const plainFirst of [true, false]) {
        const edges = plainFirst ? [withExtra(plainValue), withExtra(hostile())] : [withExtra(hostile()), withExtra(plainValue)];
        const layout = serializeEdges(edges, paths);
        const header = JSON.parse(layout.bytes.toString("utf8").split("\n")[0]!) as { bindings: unknown[] };
        expect(header.bindings, `${label}, plain first: ${plainFirst}`).toHaveLength(2);
        const back = deserializeEdges(layout.bytes, paths, index.files);
        const plain = back[plainFirst ? 0 : 1]!;
        expect((plain.binding as unknown as { extra: unknown }).extra, `${label}, plain first: ${plainFirst}`).toEqual(plainValue);
        expect(serializeEdges([plain], paths).bytes.equals(plainOnly.bytes), `${label}, plain first: ${plainFirst}`).toBe(true);
      }
    }
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

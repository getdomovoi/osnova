import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(header.formatVersion).toBe(14);
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

  it("encodes a shared plain evidence or binding object once however many edges carry it, to the same bytes as distinct copies", async () => {
    const index = await buildIndex(FIXTURE);
    const paths = [...index.files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const base = index.edges.find((edge) => edge.evidence !== undefined && edge.binding !== undefined)!;
    expect(base).toBeDefined();
    const evidence = structuredClone(base.evidence!);
    const binding = structuredClone(base.binding!);
    const nodes = new Set<unknown>();
    const collect = (value: unknown): void => {
      if (typeof value !== "object" || value === null || nodes.has(value)) return;
      nodes.add(value);
      for (const item of Object.values(value)) collect(item);
    };
    collect(evidence); collect(binding);
    let reads = 0;
    const describeProperty = Object.getOwnPropertyDescriptor;
    const keysOf = Object.keys;
    const shared: OsnovaEdge[] = Array.from({ length: 400 }, () => ({ ...base, evidence, binding }));
    const copies: OsnovaEdge[] = shared.map(() => ({ ...base, evidence: structuredClone(base.evidence!), binding: structuredClone(base.binding!) }));
    vi.spyOn(Object, "getOwnPropertyDescriptor").mockImplementation((value, key) => { if (nodes.has(value)) reads += 1; return describeProperty(value, key); });
    vi.spyOn(Object, "keys").mockImplementation((value: object) => { if (nodes.has(value)) reads += 1; return keysOf(value); });
    let layout: ReturnType<typeof serializeEdges>;
    try {
      layout = serializeEdges(shared, paths);
    } finally {
      vi.restoreAllMocks();
    }
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(40);
    expect(layout.bytes.equals(serializeEdges(copies, paths).bytes)).toBe(true);
    const transparent = <T extends object>(value: T): T => new Proxy(value, {});
    const proxied = { evidence: transparent(structuredClone(base.evidence!)), binding: transparent(structuredClone(base.binding!)) };
    expect(serializeEdges(shared.map(() => ({ ...base, ...proxied })), paths).bytes.equals(layout.bytes)).toBe(true);
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

  // Serializing hostile edges must give the bytes of fresh plain edges holding what each occurrence observed, and a
  // reload of those bytes must give back the observed edges and the same bytes again.
  const expectObservedRebuild = (edges: OsnovaEdge[], observed: OsnovaEdge[], paths: readonly string[], files: Parameters<typeof deserializeEdges>[2], label: string): void => {
    const layout = serializeEdges(edges, paths);
    const header = JSON.parse(layout.bytes.toString("utf8").split("\n")[0]!) as { bindings: unknown[] };
    const expected = serializeEdges(observed, paths);
    expect(header.bindings, label).toHaveLength(new Set(observed.map((edge) => canonical(edge.binding))).size);
    expect(layout.bytes.equals(expected.bytes), label).toBe(true);
    const back = deserializeEdges(layout.bytes, paths, files);
    expect(back, label).toEqual(observed);
    expect(serializeEdges(back, paths).bytes.equals(layout.bytes), label).toBe(true);
  };

  it("keeps proxies, nested ones included, out of JSON text key reuse in either input order", async () => {
    const index = await buildIndex(FIXTURE);
    const paths = [...index.files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const base = index.edges.find((edge) => edge.binding !== undefined)!;
    expect(base).toBeDefined();
    const withExtra = (extra: unknown): OsnovaEdge => ({ ...base, binding: { ...base.binding!, extra } as unknown as OsnovaEdge["binding"] });
    const lying = <T extends object>(target: T, key: string, answer: () => unknown): T =>
      new Proxy(target, { get: (t, k, r) => (k === key ? answer() : Reflect.get(t, k, r) as unknown) });
    const cases: [string, () => OsnovaEdge, unknown, unknown][] = [
      ["a binding proxy whose get trap boxes a value its descriptor reports plain",
        () => ({ ...base, binding: lying({ ...base.binding!, extra: 1 }, "extra", () => new Number(1)) }), 1, {}],
      ["a nested object proxy", () => withExtra(lying({ a: 1 }, "a", () => new Number(1))), { a: 1 }, { a: {} }],
      ["a nested array proxy", () => withExtra(lying([1], "0", () => new Number(1))), [1], [{}]],
      ["a binding proxy whose get trap supplies a toJSON hook its has trap hides",
        () => ({ ...base, binding: lying({ ...base.binding!, extra: 1 }, "toJSON", () => () => ({ ...base.binding!, extra: new Number(1) })) }), 1, {}],
    ];
    for (const [label, hostile, plainValue, observedValue] of cases) {
      expect(JSON.stringify(hostile()), label).toBe(JSON.stringify(withExtra(plainValue)));
      for (const plainFirst of [true, false]) {
        const edges = plainFirst ? [withExtra(plainValue), hostile()] : [hostile(), withExtra(plainValue)];
        const observed = plainFirst ? [withExtra(plainValue), withExtra(observedValue)] : [withExtra(observedValue), withExtra(plainValue)];
        expectObservedRebuild(edges, observed, paths, index.files, `${label}, plain first: ${plainFirst}`);
      }
    }
  });

  it("encodes each occurrence of a shared stateful table value with what that occurrence observes", async () => {
    const index = await buildIndex(FIXTURE);
    const paths = [...index.files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const base = index.edges.find((edge) => edge.binding !== undefined)!;
    expect(base).toBeDefined();
    const withExtra = (extra: unknown): OsnovaEdge => ({ ...base, binding: { ...base.binding!, extra } as unknown as OsnovaEdge["binding"] });
    const bindingOf = (value: object): OsnovaEdge => ({ ...base, binding: value as OsnovaEdge["binding"] });
    const accessor = (next: () => unknown): object => Object.defineProperty({ ...base.binding! }, "extra", { enumerable: true, get: next });
    const hook = (next: () => unknown): object => Object.defineProperty({ ...base.binding! }, "toJSON", { value: () => ({ ...base.binding!, extra: next() }) });
    const proxy = (next: () => unknown): object =>
      new Proxy({ ...base.binding!, extra: "x" }, { get: (t, k, r) => (k === "extra" ? next() : Reflect.get(t, k, r) as unknown) });
    const sequence = (): (() => unknown) => { const values = ["g", "h", "i"]; return () => values.shift(); };
    const observed = (count: number): OsnovaEdge[] => ["g", "h", "i"].slice(0, count).map(withExtra);
    const cases: [string, () => OsnovaEdge[], OsnovaEdge[]][] = [
      ["one shared accessor", () => { const shared = bindingOf(accessor(sequence())); return [shared, shared, shared]; }, observed(3)],
      ["one shared toJSON hook", () => { const shared = bindingOf(hook(sequence())); return [shared, shared, shared]; }, observed(3)],
      ["one shared stateful proxy", () => { const shared = bindingOf(proxy(sequence())); return [shared, shared, shared]; }, observed(3)],
      ["distinct accessor copies", () => { const next = sequence(); return [bindingOf(accessor(next)), bindingOf(accessor(next))]; }, observed(2)],
      ["distinct toJSON hook copies", () => { const next = sequence(); return [bindingOf(hook(next)), bindingOf(hook(next))]; }, observed(2)],
      ["distinct stateful proxy copies", () => { const next = sequence(); return [bindingOf(proxy(next)), bindingOf(proxy(next))]; }, observed(2)],
      ["a shared plain value a hook rewrites between its occurrences", () => {
        const plain = { ...base.binding!, extra: "g" };
        const rewriter = Object.defineProperty({ ...base.binding! }, "toJSON", { value: () => { plain.extra = "i"; return { ...base.binding!, extra: "h" }; } });
        return [bindingOf(plain), bindingOf(rewriter), bindingOf(plain)];
      }, observed(3)],
    ];
    for (const [label, edges, expected] of cases) expectObservedRebuild(edges(), expected, paths, index.files, label);
  });

  // Route and overload edges built on one resolved call; the reload of the serialized bytes must give back the
  // edges each occurrence observed, and those bytes must equal the bytes of fresh plain copies of them.
  const preparedEdges = async () => {
    const index = await buildIndex(FIXTURE);
    const paths = [...index.files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const call = index.edges.find((edge) => edge.kind === "calls" && edge.toSymbol !== undefined)!;
    expect(call).toBeDefined();
    const core: { -readonly [K in keyof OsnovaEdge]: OsnovaEdge[K] } = { ...call };
    delete core.binding; delete core.route; delete core.arguments; delete core.overload; delete core.constructs;
    const routeEdge = (route: object): OsnovaEdge => ({ ...core, kind: "routes", route: route as OsnovaEdge["route"] & object });
    const overloadEdge = (overload: object): OsnovaEdge => ({ ...core, kind: "calls", arguments: 2, overload: overload as OsnovaEdge["overload"] & object });
    const expectRebuild = (edges: OsnovaEdge[], observed: OsnovaEdge[], label: string): void => {
      const layout = serializeEdges(edges, paths);
      expect(layout.bytes.equals(serializeEdges(observed, paths).bytes), label).toBe(true);
      const back = deserializeEdges(layout.bytes, paths, index.files);
      expect(back, label).toEqual(observed);
      expect(serializeEdges(back, paths).bytes.equals(layout.bytes), label).toBe(true);
    };
    return { routeEdge, overloadEdge, expectRebuild, paths };
  };

  it("encodes each occurrence of a shared route or overload with what preparation reads through hidden properties", async () => {
    const { routeEdge, overloadEdge, expectRebuild } = await preparedEdges();
    const hiddenPath = (read: () => string): object => Object.defineProperty({ method: "GET" }, "path", { get: read });
    const hiddenEvery = (candidates: number[], effect: () => void): number[] => Object.defineProperty(candidates, "every", {
      value(this: number[], test: (item: number, i: number, all: number[]) => boolean) { effect(); return Array.prototype.every.call(this, test as never); },
    });
    const route = (path: string): OsnovaEdge => routeEdge({ method: "GET", path });
    const overload = (first: number): OsnovaEdge => overloadEdge({ candidates: [first, 10] });
    // Preparation may read a property more than once, so each hidden read answers the same within one occurrence;
    // the hostile value in the middle changes what the shared one answers at its next occurrence.
    const cases: [string, () => OsnovaEdge[], OsnovaEdge[]][] = [
      ["one shared route whose path is a hidden getter", () => {
        const state = { path: "/g" };
        const shared = routeEdge(hiddenPath(() => state.path));
        return [shared, routeEdge(hiddenPath(() => { state.path = "/i"; return "/h"; })), shared];
      }, [route("/g"), route("/h"), route("/i")]],
      ["one shared overload whose candidates hide a stateful every", () => {
        const state = { first: 1 };
        const candidates = [0, 10];
        const shared = overloadEdge({ candidates: hiddenEvery(candidates, () => { candidates[0] = state.first; }) });
        return [shared, overloadEdge({ candidates: hiddenEvery([5, 10], () => { state.first = 2; }) }), shared];
      }, [overload(1), overload(5), overload(2)]],
      ["a shared plain route a hidden path getter rewrites between its occurrences", () => {
        const plain = { method: "GET", path: "/g" };
        const rewriter = hiddenPath(() => { plain.path = "/i"; return "/h"; });
        return [routeEdge(plain), routeEdge(rewriter), routeEdge(plain)];
      }, [route("/g"), route("/h"), route("/i")]],
      ["a shared plain overload a hidden every rewrites between its occurrences", () => {
        const plain = { candidates: [1, 10] };
        const rewriter = { candidates: hiddenEvery([5, 10], () => { plain.candidates[0] = 2; }) };
        return [overloadEdge(plain), overloadEdge(rewriter), overloadEdge(plain)];
      }, [overload(1), overload(5), overload(2)]],
    ];
    for (const [label, edges, expected] of cases) expectRebuild(edges(), expected, label);
  });

  it("encodes a valid route whose ignored extra field is cyclic or deeply nested as the route alone", async () => {
    const { routeEdge, expectRebuild } = await preparedEdges();
    const plain = routeEdge({ method: "GET", path: "/c" });
    const cyclic: Record<string, unknown> = { method: "GET", path: "/c" };
    cyclic.self = cyclic;
    const loop: unknown[] = [];
    loop.push({ back: loop });
    let deep: object = {};
    for (let i = 0; i < 100_000; i += 1) deep = { next: deep };
    const cases: [string, () => OsnovaEdge[]][] = [
      ["a route that holds itself", () => { const shared = routeEdge(cyclic); return [shared, shared]; }],
      ["copies of a route whose extra field is a cyclic array", () => [routeEdge({ method: "GET", path: "/c", extra: loop }), routeEdge({ method: "GET", path: "/c", extra: loop })]],
      ["a route whose extra field nests deeper than the stack", () => [routeEdge({ method: "GET", path: "/c", extra: deep })]],
    ];
    for (const [label, edges] of cases) {
      const input = edges();
      expectRebuild(input, input.map(() => plain), label);
    }
  });

  it("scans a route whose ignored extra field shares acyclic subobjects once per object", async () => {
    const { routeEdge, expectRebuild, paths } = await preparedEdges();
    const plain = routeEdge({ method: "GET", path: "/d" });
    let tree: object = {};
    let list: unknown[] = [];
    for (let i = 0; i < 40; i += 1) { tree = { left: tree, right: tree }; list = [list, list]; }
    const route = { method: "GET", path: "/d", extra: { tree, list } };
    const input = [routeEdge(route), routeEdge(route), routeEdge({ ...route })];
    const describeProperty = Object.getOwnPropertyDescriptor;
    let reads = 0;
    vi.spyOn(Object, "getOwnPropertyDescriptor").mockImplementation((value, key) => {
      reads += 1;
      if (reads > 2_000) throw new Error("descriptor read budget exceeded");
      return describeProperty(value, key);
    });
    try {
      serializeEdges(input, paths);
    } finally {
      vi.restoreAllMocks();
    }
    expect(reads).toBeLessThanOrEqual(2_000);
    expectRebuild(input, input.map(() => plain), "shared acyclic subobjects");
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

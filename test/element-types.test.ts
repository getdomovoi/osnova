import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";

let temporary: string;
beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-elements-")); });
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });
async function build(files: Record<string, string>) {
  const root = path.join(temporary, "ws"); await fs.mkdir(root);
  for (const [name, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); }
  return buildIndex(root, { cacheDir: path.join(temporary, "cache") });
}
const hits = (index: Awaited<ReturnType<typeof build>>, symbol: string, name = "hit") =>
  [...index.outgoing(symbol).filter((edge) => edge.toName === name)].sort((a, b) => a.line - b.line).map((edge) => edge.toSymbol);

describe("element types", () => {
  it("TypeScript: for-of and array callbacks over annotated parameters, fields and returns", async () => {
    const index = await build({
      "lib.ts": "export class Foo { hit() {} }\nexport class Pool {\n  items: Foo[] = [];\n  constructor(readonly spare: ReadonlyArray<Foo>) {}\n  all(): Foo[] { return this.items; }\n}\nexport interface Bag { things: Set<Foo>; count: number }\nexport function list(): Array<Foo> { return []; }\nexport function one(): Foo { return new Foo(); }\n",
      "a.ts": "import { Foo, Pool, Bag, list, one } from './lib.js';\nexport function use(xs: Foo[], ys: readonly Foo[], zs: Foo[] | undefined, p: Pool, b: Bag, ns: number[]) {\n  for (const x of xs) x.hit();\n  for (const y of ys) y.hit();\n  for (const z of zs ?? []) z.hit();\n  xs.forEach((x) => x.hit());\n  xs.map(function (x) { x.hit(); });\n  xs.filter(x => x.hit());\n  for (const i of p.items) i.hit();\n  for (const s of p.spare) s.hit();\n  for (const t of b.things) t.hit();\n  for (const c of b.count) c.hit();\n  for (const l of list()) l.hit();\n  for (const a of p.all()) a.hit();\n  for (const o of one()) o.hit();\n  for (const n of ns) n.hit();\n  for (let m of xs) { m = new Foo(); m.hit(); }\n  for (const k in xs) k.hit();\n  const w = xs;\n  for (const v of w) v.hit();\n}\n",
    });
    expect(index.symbols.get("lib.ts#Pool")).toMatchObject({ elementTypes: { items: { kind: "local", name: "Foo" }, spare: { kind: "local", name: "Foo" } } });
    expect(index.symbols.get("lib.ts#Bag")?.elementTypes).toEqual({ things: { kind: "local", name: "Foo" } });
    expect(index.symbols.get("lib.ts#list")?.elements).toEqual({ kind: "local", name: "Foo" });
    expect(index.symbols.get("lib.ts#Pool.all")?.elements).toEqual({ kind: "local", name: "Foo" });
    const F = "lib.ts#Foo.hit";
    expect(hits(index, "a.ts#use")).toEqual([F, F, undefined, F, F, F, F, F, F, undefined, F, F, undefined, undefined, undefined, undefined, undefined]);
    const first = index.outgoing("a.ts#use").find((edge) => edge.toName === "hit");
    expect(first?.binding).toEqual({ kind: "member", owner: { kind: "import", source: "./lib.js", importedName: "Foo" }, member: "hit", mode: "instance", basis: "annotation" });
    const field = index.outgoing("a.ts#use").filter((edge) => edge.toName === "hit")[6];
    expect(field?.binding).toMatchObject({ owner: { kind: "element", of: { kind: "field", of: { kind: "import", importedName: "Pool" }, member: "items" } } });
  });

  it("TypeScript: Map values, get, subscripts, pass-through calls and local aliases", async () => {
    const index = await build({
      "lib.ts": "export class Foo { hit() {} }\nexport class Store {\n  byName: Map<string, Foo> = new Map();\n  list: Foo[] = [];\n  nested: Store | undefined;\n  get(name: string): Foo | undefined { return this.byName.get(name); }\n}\nexport function table(): Map<number, Foo> { return new Map(); }\n",
      "a.ts": "import { Foo, Store } from './lib.js';\nexport function use(s: Store, m: Map<string, Foo>, xs: Foo[], r: Record<string, Foo>) {\n  m.forEach((v) => v.hit());\n  s.byName.forEach((v, k) => v.hit());\n  for (const v of m.values()) v.hit();\n  for (const v of s.byName.values()) v.hit();\n  m.get('a')?.hit();\n  s.byName.get('a')!.hit();\n  s.get('a')?.hit();\n  xs[0].hit();\n  s.list[1].hit();\n  r['k'].hit();\n  for (const x of xs.filter((x) => true)) x.hit();\n  for (const x of s.list.slice(1)) x.hit();\n  for (const e of m) e.hit();\n  const list = s.list;\n  for (const x of list) x.hit();\n  const first = s.list[0];\n  first.hit();\n  const inner = s.nested;\n  inner.get('a')!.hit();\n  let alias = s.list;\n  alias = [];\n  for (const x of alias) x.hit();\n}\n",
    });
    expect(index.symbols.get("lib.ts#Store")).toMatchObject({ elementTypes: { list: { kind: "local", name: "Foo" } }, valueTypes: { byName: { kind: "local", name: "Foo" } } });
    expect(index.symbols.get("lib.ts#table")?.values).toEqual({ kind: "local", name: "Foo" });
    const F = "lib.ts#Foo.hit";
    expect(hits(index, "a.ts#use")).toEqual([F, F, F, F, F, F, F, F, F, F, F, F, undefined, F, F, F, undefined]);
  });

  it("Python: for loops and comprehensions over annotated collections", async () => {
    const index = await build({
      "lib.py": "from typing import Iterable, List\n\nclass Foo:\n    def hit(self):\n        pass\n\nclass Pool:\n    items: list[Foo]\n    def all(self) -> List[Foo]:\n        return self.items\n\ndef make() -> Iterable[Foo]:\n    return []\n",
      "a.py": "from lib import Foo, Pool, make\n\ndef use(xs: list[Foo], p: Pool, d: dict[str, Foo]):\n    for x in xs:\n        x.hit()\n    for i in p.items:\n        i.hit()\n    for a in p.all():\n        a.hit()\n    for m in make():\n        m.hit()\n    for k in d:\n        k.hit()\n    [y.hit() for y in xs]\n    for x in xs:\n        x = Foo()\n        x.hit()\n    for v in d.values():\n        v.hit()\n    d['k'].hit()\n    d.get('k').hit()\n    xs[0].hit()\n    items = p.items\n    for j in items:\n        j.hit()\n    head = xs[0]\n    head.hit()\n",
    });
    expect(index.symbols.get("lib.py#Pool")?.elementTypes).toEqual({ items: { kind: "local", name: "Foo" } });
    expect(index.symbols.get("lib.py#make")?.elements).toEqual({ kind: "local", name: "Foo" });
    const F = "lib.py#Foo.hit";
    expect(hits(index, "a.py#use")).toEqual([undefined, F, F, F, undefined, F, undefined, F, F, F, F, F, F]);
  });
});

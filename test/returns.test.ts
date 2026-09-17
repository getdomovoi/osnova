import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";

let temporary: string;
beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-returns-")); });
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });
async function build(files: Record<string, string>) {
  const root = path.join(temporary, "ws"); await fs.mkdir(root);
  for (const [name, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); }
  return buildIndex(root, { cacheDir: path.join(temporary, "cache") });
}
const hits = (index: Awaited<ReturnType<typeof build>>, symbol: string, name = "hit") =>
  [...index.outgoing(symbol).filter((edge) => edge.toName === name)].sort((a, b) => a.line - b.line).map((edge) => edge.toSymbol);

describe("return-type receivers", () => {
  it("resolves calls on the result of an annotated function, local or imported, and on a stored result", async () => {
    const index = await build({
      "lib.ts": "export class Foo { hit() {} }\nexport function make(): Foo { return new Foo(); }\nexport function vague() { return new Foo(); }\nexport function maybe(): Foo | undefined { return undefined; }\nexport function later(): Promise<Foo> { return Promise.resolve(new Foo()); }\n",
      "a.ts": "import { make, vague, maybe, later } from './lib.js';\nimport type { Foo } from './lib.js';\nfunction local(): Foo { return make(); }\nexport function use() {\n  make().hit();\n  const x = make();\n  x.hit();\n  local().hit();\n  vague().hit();\n  maybe().hit();\n  later().hit();\n  let y = make();\n  y = vague();\n  y.hit();\n}\n",
    });
    expect(index.symbols.get("lib.ts#make")?.returns).toEqual({ kind: "local", name: "Foo" });
    expect(index.symbols.get("a.ts#local")?.returns).toEqual({ kind: "import", source: "./lib.js", importedName: "Foo" });
    expect(hits(index, "a.ts#use")).toEqual(["lib.ts#Foo.hit", "lib.ts#Foo.hit", "lib.ts#Foo.hit", undefined, "lib.ts#Foo.hit", undefined, undefined]);
    const first = index.outgoing("a.ts#use").find((edge) => edge.toName === "hit");
    expect(first?.evidence).toMatchObject({ resolution: { method: "receiver-hint", receiver: { classSymbol: "lib.ts#Foo", basis: "return" } } });
  });

  it("follows method return types, `this` returns and chains through inheritance", async () => {
    const index = await build({
      "a.ts": "class Foo { hit() {} }\nclass Builder {\n  make(): Foo { return new Foo(); }\n  trim(): this { return this; }\n  self() { return this; }\n  run() {\n    this.make().hit();\n    this.trim().make().hit();\n    this.self().make().hit();\n  }\n}\nclass Sub extends Builder {}\nfunction builder(): Builder { return new Builder(); }\nfunction use(b: Builder, s: Sub) {\n  b.make().hit();\n  builder().trim().trim().make().hit();\n  s.make().hit();\n  s.trim().make().hit();\n}\n",
    });
    expect(index.symbols.get("a.ts#Builder.trim")?.returns).toEqual({ kind: "this" });
    expect(hits(index, "a.ts#Builder.run")).toEqual(["a.ts#Foo.hit", "a.ts#Foo.hit", undefined]);
    expect(hits(index, "a.ts#use")).toEqual(["a.ts#Foo.hit", "a.ts#Foo.hit", "a.ts#Foo.hit", "a.ts#Foo.hit"]);
  });

  it("resolves interface method signatures with declared return types", async () => {
    const index = await build({
      "a.ts": "interface Foo { hit(): void; }\ninterface Source { get(): Foo; pick: () => Foo; }\nfunction use(s: Source) {\n  s.get().hit();\n  s.pick().hit();\n}\n",
    });
    expect(hits(index, "a.ts#use")).toEqual(["a.ts#Foo.hit", "a.ts#Foo.hit"]);
  });

  it("resolves Python return annotations on functions and methods, including Self", async () => {
    const index = await build({
      "lib.py": "class Foo:\n    def hit(self):\n        return 1\n\ndef make() -> Foo:\n    return Foo()\n\ndef vague():\n    return Foo()\n\ndef quoted() -> 'Foo':\n    return Foo()\n",
      "app.py": "from lib import make, vague, quoted, Foo\nfrom typing import Self\n\nclass Builder:\n    def make(self) -> Foo:\n        return Foo()\n\n    def chain(self) -> Self:\n        return self\n\n    def run(self):\n        self.make().hit()\n        self.chain().make().hit()\n\ndef use():\n    make().hit()\n    x = make()\n    x.hit()\n    vague().hit()\n    quoted().hit()\n    y = vague()\n    y.hit()\n    b = Builder()\n    b.make().hit()\n",
    });
    expect(index.symbols.get("lib.py#make")?.returns).toEqual({ kind: "local", name: "Foo" });
    expect(hits(index, "app.py#Builder.run")).toEqual(["lib.py#Foo.hit", "lib.py#Foo.hit"]);
    expect(hits(index, "app.py#use")).toEqual(["lib.py#Foo.hit", "lib.py#Foo.hit", undefined, undefined, undefined, "lib.py#Foo.hit"]);
  });

  it("stays unresolved when the return type is not a unique indexed class or the callee is unknown", async () => {
    const index = await build({
      "a.ts": "type Alias = { hit(): void };\nfunction alias(): Alias { return { hit() {} }; }\nfunction unknownCallee() { return 1; }\nexport function use(g: () => unknown) {\n  alias().hit();\n  g().hit();\n  (unknownCallee as any)().hit();\n  [1].map(String).hit();\n}\n",
    });
    expect(hits(index, "a.ts#use")).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("keeps `this` returns relative to the receiver and survives deep chains in the artifact", async () => {
    const index = await build({
      "a.ts": "class B { chain(): this { return this; } hit() {} }\nclass D extends B { hit() {} }\nfunction make(): B { return new B(); }\nfunction use(d: D) {\n  d.chain().hit();\n  make().chain().chain().chain().chain().chain().chain().chain().chain().chain().hit();\n  make().chain().chain().hit();\n}\n",
      "b.py": "from typing import Self\n\nclass B:\n    @classmethod\n    def make(cls) -> Self:\n        return cls()\n\n    def hit(self):\n        pass\n\nclass D(B):\n    def hit(self):\n        pass\n\ndef use():\n    D.make().hit()\n",
    });
    expect(hits(index, "a.ts#use")).toEqual(["a.ts#D.hit", undefined, "a.ts#B.hit"]);
    expect(hits(index, "b.py#use")).toEqual(["b.py#D.hit"]);
    const { serializeSections, deserializeArtifact } = await import("../src/index/serialize.js");
    const sections = serializeSections(index);
    const loaded = deserializeArtifact(sections.core.toString("utf8"), undefined, sections.text.bytes, sections.edges.bytes);
    expect(loaded.edges.filter((edge) => edge.fromSymbol === "a.ts#use" && edge.toName === "hit").length).toBe(3);
  });

  it("refuses overloads that disagree, getters, static or decorated callees, coroutines and a shadowed Self", async () => {
    const index = await build({
      "a.ts": "class A { hit() {} }\nclass B { hit() {} }\ninterface Source { make(x: string): A; make(x: number): B; same(x: string): A; same(x: number): A; }\nclass G { get make(): A { return new A(); } static build(): A { return new A(); } inst(): A { return new A(); } }\nfunction use(s: Source, g: G) {\n  s.make(1).hit();\n  s.same(1).hit();\n  g.make().hit();\n  g.build().hit();\n  G.inst().hit();\n  G.build().hit();\n  A().hit();\n}\n",
      "p.py": "import typing as t\n\ndef wrap(f):\n    return f\n\nclass A:\n    def hit(self):\n        pass\n\nclass Self:\n    def hit(self):\n        pass\n\nclass M:\n    @wrap\n    def make(self) -> A:\n        return A()\n\n    def own(self) -> Self:\n        return Self()\n\n    def odd(self) -> t.Self.other:\n        return None\n\n    def hit(self):\n        pass\n\nasync def later() -> A:\n    return A()\n\ndef gen() -> A:\n    yield A()\n\ndef outer() -> A:\n    def items():\n        yield 1\n    return A()\n\ndef use(m: M):\n    m.make().hit()\n    m.own().hit()\n    later().hit()\n    gen().hit()\n    outer().hit()\n    m.odd().hit()\n",
    });
    expect(hits(index, "a.ts#use")).toEqual([undefined, "a.ts#A.hit", undefined, undefined, undefined, "a.ts#A.hit", undefined]);
    expect(hits(index, "p.py#use")).toEqual([undefined, "p.py#Self.hit", undefined, undefined, "p.py#A.hit", undefined]);
  });
});

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
  it("infers the result from constructor-literal and this returns when there is no annotation", async () => {
    const index = await build({
      "lib.ts": "export class Foo { hit() {} }\nexport class Bar { hit() {} }\n",
      "a.ts": "import { Foo, Bar } from './lib.js';\nexport function make() { return new Foo(); }\nexport const arrow = () => new Foo();\nexport function branches(flag: boolean) { if (flag) { return new Foo(); } return new Foo(); }\nexport function mixed(flag: boolean) { return flag ? new Foo() : new Bar(); }\nexport function twoKinds(flag: boolean) { if (flag) return new Foo(); return new Bar(); }\nexport function nested() { const inner = () => new Bar(); return new Foo(); }\nexport function bare() { return; }\nexport async function later() { return new Foo(); }\nexport class Builder { self() { return this; } hit() {} }\nexport function use(b: Builder) {\n  make().hit();\n  arrow().hit();\n  branches(true).hit();\n  mixed(true).hit();\n  twoKinds(true).hit();\n  nested().hit();\n  later().hit();\n  b.self().hit();\n}\nexport async function useAsync() {\n  (await later()).hit();\n}\n",
    });
    expect(index.symbols.get("a.ts#make")?.returns).toEqual({ kind: "import", source: "./lib.js", importedName: "Foo" });
    expect(index.symbols.get("a.ts#arrow")?.returns).toEqual({ kind: "import", source: "./lib.js", importedName: "Foo" });
    expect(index.symbols.get("a.ts#mixed")?.returns).toBeUndefined();
    expect(index.symbols.get("a.ts#twoKinds")?.returns).toBeUndefined();
    expect(index.symbols.get("a.ts#bare")?.returns).toBeUndefined();
    expect(index.symbols.get("a.ts#later")?.returns).toBeUndefined();
    expect(index.symbols.get("a.ts#later")?.unwrapped).toEqual({ kind: "import", source: "./lib.js", importedName: "Foo" });
    expect(index.symbols.get("a.ts#Builder.self")?.returns).toEqual({ kind: "this" });
    const F = "lib.ts#Foo.hit";
    expect(hits(index, "a.ts#use")).toEqual([F, F, F, undefined, undefined, F, undefined, "a.ts#Builder.hit"]);
    expect(hits(index, "a.ts#useAsync")).toEqual([F]);
  });

  it("Python: infers the result from a constructor call return without an annotation", async () => {
    const index = await build({
      "lib.py": "class Foo:\n    def hit(self):\n        pass\n\nclass Bar:\n    def hit(self):\n        pass\n",
      "a.py": "from lib import Foo, Bar\n\ndef make():\n    return Foo()\n\ndef either(flag):\n    if flag:\n        return Foo()\n    return Bar()\n\ndef gen():\n    yield Foo()\n\nasync def later():\n    return Foo()\n\ndef use():\n    make().hit()\n    either(True).hit()\n\nasync def use_async():\n    (await later()).hit()\n",
    });
    expect(index.symbols.get("a.py#make")?.returns).toEqual({ kind: "import", source: "lib", importedName: "Foo" });
    expect(index.symbols.get("a.py#either")?.returns).toBeUndefined();
    expect(index.symbols.get("a.py#gen")?.returns).toBeUndefined();
    expect(index.symbols.get("a.py#later")?.unwrapped).toEqual({ kind: "import", source: "lib", importedName: "Foo" });
    expect(hits(index, "a.py#use")).toEqual(["lib.py#Foo.hit", undefined]);
    expect(hits(index, "a.py#use_async")).toEqual(["lib.py#Foo.hit"]);
  });

  it("Python: Optional and None unions name the non-null type in parameters, returns, fields and overloads", async () => {
    const index = await build({
      "lib.py": "from typing import Optional, Union, overload\nimport typing as t\n\nclass Foo:\n    def hit(self):\n        pass\n\nclass Holder:\n    foo: Optional[Foo]\n    foos: Optional[list[Foo]]\n\n@overload\ndef current(silent: bool = False) -> Foo: ...\n@overload\ndef current(silent: bool = ...) -> Foo | None: ...\ndef current(silent=False) -> Foo | None:\n    return Foo()\n\ndef maybe() -> Union[Foo, None]:\n    return None\n\ndef either() -> Union[Foo, Holder]:\n    return Foo()\n",
      "a.py": "from lib import Foo, Holder, current, maybe, either\nfrom typing import Optional\nimport typing as t\n\ndef use(a: Foo | None, b: Optional[Foo], c: t.Optional[Foo], d: None | Foo, h: Holder):\n    a.hit()\n    b.hit()\n    c.hit()\n    d.hit()\n    current().hit()\n    maybe().hit()\n    either().hit()\n    h.foo.hit()\n    for f in h.foos:\n        f.hit()\n",
    });
    expect(index.symbols.get("lib.py#current")?.returns).toEqual({ kind: "local", name: "Foo" });
    expect(index.symbols.get("lib.py#either")?.returns).toBeUndefined();
    expect(index.symbols.get("lib.py#Holder")).toMatchObject({ fieldTypes: { foo: { kind: "local", name: "Foo" } }, elementTypes: { foos: { kind: "local", name: "Foo" } } });
    const F = "lib.py#Foo.hit";
    expect(hits(index, "a.py#use")).toEqual([F, F, F, F, F, F, undefined, F, F]);
  });

  it("requires imported overload declarations to agree on the return type", async () => {
    const index = await build({
      "lib.py": "from typing import overload\n\nclass Foo:\n    def hit(self):\n        pass\n\nclass Other:\n    def hit(self):\n        pass\n\n@overload\ndef pick(a: str) -> Foo: ...\n@overload\ndef pick(a: int) -> Other: ...\ndef pick(a) -> Foo:\n    return Foo()\n\n@overload\ndef same(a: str) -> Foo: ...\n@overload\ndef same(a: int) -> Foo: ...\ndef same(a) -> Foo:\n    return Foo()\n",
      "a.py": "from lib import pick, same\n\ndef use():\n    pick('x').hit()\n    same('x').hit()\n",
    });
    expect(index.files.get("lib.py")?.symbols.filter((symbol) => symbol.name === "pick").map((symbol) => symbol.returns)).toEqual([{ kind: "local", name: "Foo" }, { kind: "local", name: "Other" }, { kind: "local", name: "Foo" }]);
    expect(hits(index, "a.py#use")).toEqual([undefined, "lib.py#Foo.hit"]);
  });

  it("names the interface when a const shares its name, in return types and heritage", async () => {
    const index = await build({
      "a.ts": "export interface Foo { hit(): void }\nexport const Foo = make();\nfunction make(): any { return {}; }\nexport function build(): Foo { return Foo; }\nexport interface Bar extends Foo {}\nexport function bar(): Bar { return build(); }\nexport function use() {\n  build().hit();\n  bar().hit();\n}\n",
    });
    expect(index.symbols.get("a.ts#build")?.returns).toEqual({ kind: "local", name: "Foo" });
    expect(index.files.get("a.ts")?.symbols.find((symbol) => symbol.name === "Bar")?.heritage).toEqual([{ kind: "local", name: "Foo" }]);
    expect(hits(index, "a.ts#use")).toEqual(["a.ts#Foo.hit", "a.ts#Foo.hit"]);
  });

  it("resolves calls on the result of an annotated function, local or imported, and on a stored result", async () => {
    const index = await build({
      "lib.ts": "export class Foo { hit() {} }\nexport function make(): Foo { return new Foo(); }\nexport function vague() { return new Foo(); }\nexport function maybe(): Foo | undefined { return undefined; }\nexport function later(): Promise<Foo> { return Promise.resolve(new Foo()); }\n",
      "a.ts": "import { make, vague, maybe, later } from './lib.js';\nimport type { Foo } from './lib.js';\nfunction local(): Foo { return make(); }\nexport function use() {\n  make().hit();\n  const x = make();\n  x.hit();\n  local().hit();\n  vague().hit();\n  maybe().hit();\n  later().hit();\n  let y = make();\n  y = vague();\n  y.hit();\n}\n",
    });
    expect(index.symbols.get("lib.ts#make")?.returns).toEqual({ kind: "local", name: "Foo" });
    expect(index.symbols.get("a.ts#local")?.returns).toEqual({ kind: "import", source: "./lib.js", importedName: "Foo" });
    expect(hits(index, "a.ts#use")).toEqual(["lib.ts#Foo.hit", "lib.ts#Foo.hit", "lib.ts#Foo.hit", "lib.ts#Foo.hit", "lib.ts#Foo.hit", undefined, undefined]);
    const first = index.outgoing("a.ts#use").find((edge) => edge.toName === "hit");
    expect(first?.evidence).toMatchObject({ resolution: { method: "receiver-hint", receiver: { classSymbol: "lib.ts#Foo", basis: "return" } } });
  });

  it("follows method return types, `this` returns and chains through inheritance", async () => {
    const index = await build({
      "a.ts": "class Foo { hit() {} }\nclass Builder {\n  make(): Foo { return new Foo(); }\n  trim(): this { return this; }\n  self() { return this; }\n  run() {\n    this.make().hit();\n    this.trim().make().hit();\n    this.self().make().hit();\n  }\n}\nclass Sub extends Builder {}\nfunction builder(): Builder { return new Builder(); }\nfunction use(b: Builder, s: Sub) {\n  b.make().hit();\n  builder().trim().trim().make().hit();\n  s.make().hit();\n  s.trim().make().hit();\n}\n",
    });
    expect(index.symbols.get("a.ts#Builder.trim")?.returns).toEqual({ kind: "this" });
    expect(hits(index, "a.ts#Builder.run")).toEqual(["a.ts#Foo.hit", "a.ts#Foo.hit", "a.ts#Foo.hit"]);
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
    expect(hits(index, "app.py#use")).toEqual(["lib.py#Foo.hit", "lib.py#Foo.hit", "lib.py#Foo.hit", undefined, "lib.py#Foo.hit", "lib.py#Foo.hit"]);
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

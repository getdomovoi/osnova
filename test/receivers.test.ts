import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex, applyChanges, loadIndex, serializeArtifact } from "../src/index.js";
import { deserializeArtifact, serializeSections } from "../src/index/serialize.js";
import { sha256Hex } from "../src/index/scan.js";

let temporary: string;
let workspace: string;
let cacheDir: string;
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-receivers-"));
  workspace = path.join(temporary, "workspace"); cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
});
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

async function build(files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await fs.writeFile(path.join(workspace, file), text);
  }
  return buildIndex(workspace, { cacheDir });
}

describe("receiver identity", () => {
  it("indexes interface property signatures with function types as methods", async () => {
    const index = await build({
      "console.ts": "export interface ConsoleInterface { error: (message: string) => void; level: number; }\nexport function use(c: ConsoleInterface) { c.error('x'); }\n",
    });
    expect(index.symbols.get("console.ts#ConsoleInterface.error")).toMatchObject({ kind: "method", memberKind: "instance" });
    expect(index.symbols.has("console.ts#ConsoleInterface.level")).toBe(false);
    expect(index.outgoing("console.ts#use")[0]?.toSymbol).toBe("console.ts#ConsoleInterface.error");
  });

  it("finds inherited members through class and interface heritage", async () => {
    const index = await build({
      "base.ts": "export class Base { send() {} }\nexport interface Reader { read(): void; }\nexport interface Both extends Reader { write(): void; }\n",
      "mid.ts": "import { Base } from './base.js';\nexport class Mid extends Base {}\n",
      "leaf.ts": "import { Mid } from './mid.js';\nimport * as base from './base.js';\nexport class Leaf extends Mid {}\nexport class Loop extends Loop2 {}\nexport class Loop2 extends Loop {}\nexport function go(leaf: Leaf, both: base.Both, loop: Loop) {\n  both.read();\n  leaf.send();\n  loop.send();\n}\n",
    });
    expect(index.symbols.get("leaf.ts#Leaf")?.heritage).toEqual([{ kind: "import", source: "./mid.js", importedName: "Mid" }]);
    expect(index.symbols.get("base.ts#Both")?.heritage).toEqual([{ kind: "local", name: "Reader" }]);
    const calls = [...index.outgoing("leaf.ts#go")].sort((a, b) => a.line - b.line || a.toName.localeCompare(b.toName));
    expect(calls.map((edge) => [edge.toName, edge.toSymbol])).toEqual([["read", "base.ts#Reader.read"], ["send", "base.ts#Base.send"], ["send", undefined]]);
    expect(calls[1]?.evidence).toMatchObject({ resolution: { method: "receiver-hint", receiver: { classSymbol: "leaf.ts#Leaf", basis: "annotation" } } });
  });

  it("leaves heritage unresolved when bases disagree, are unknown, merge, or are only implemented", async () => {
    const index = await build({
      "mro.py": "class A:\n    def hit(self): pass\nclass B(A): pass\nclass C:\n    def hit(self): pass\nclass D(B, C): pass\nclass Diamond(B, A): pass\ndef use(d: D, e: Diamond):\n    d.hit()\n    e.hit()\n",
      "unknown.py": "from unavailable import Unknown\nclass Known:\n    def hit(self): pass\nclass D(Unknown, Known): pass\nclass Own(Unknown):\n    def hit(self): pass\ndef use(d: D, o: Own):\n    d.hit()\n    o.hit()\n",
      "a.ts": "interface A { hit(): void; }\ninterface B { hit(): void; }\ninterface I extends A {}\ninterface I extends B {}\ninterface J { hit(): void; }\nclass Base { hit() {} }\nclass D extends Base implements J {}\nclass Field extends Base { hit = 2; }\nclass Arrow extends Base { hit = () => 2; }\nclass Generic<T> extends Base {}\nclass Sub extends Generic<string> {}\nfunction use(i: I, d: D, f: Field, a: Arrow, s: Sub) {\n  i.hit();\n  d.hit();\n  f.hit();\n  a.hit();\n  s.hit();\n}\n",
    });
    const sends = (symbol: string) => [...index.outgoing(symbol).filter((edge) => edge.toName === "hit")].sort((a, b) => a.line - b.line).map((edge) => edge.toSymbol);
    expect(sends("mro.py#use")).toEqual([undefined, "mro.py#A.hit"]);
    expect(sends("unknown.py#use")).toEqual([undefined, "unknown.py#Own.hit"]);
    expect(index.symbols.get("a.ts#Field")?.fields).toEqual(["hit"]);
    expect(index.symbols.get("a.ts#D")?.heritage).toEqual([{ kind: "local", name: "Base" }]);
    expect(sends("a.ts#use")).toEqual([undefined, "a.ts#Base.hit", undefined, "a.ts#Arrow.hit", "a.ts#Base.hit"]);
  });

  it("binds field receivers at their declaration and blocks static, rewritten or conditionally assigned fields", async () => {
    const index = await build({
      "lib.ts": "export interface Reader { hit(): void; }\n",
      "a.ts": "import type { Reader } from './lib.js';\nclass Foo { hit() {} }\nclass Shadow {\n  constructor() { this.x = new Foo(); }\n  use() { class Foo { hit() {} } this.x.hit(); }\n}\nclass Static { static x: Foo; use() { this.x.hit(); } }\nclass Rewritten { x: Foo; constructor() { this.x = new Foo(); } reset() { this.x = {} as any; } use() { this.x.hit(); } }\nclass Nested { constructor() { (() => { this.x = new Foo(); }); } use() { this.x.hit(); } }\nclass Readonly { constructor(readonly x: Foo) {} use() { this.x.hit(); } }\nfunction typed(r: Reader) { r.hit(); }\n",
    });
    const hit = (symbol: string) => index.outgoing(symbol).find((edge) => edge.toName === "hit")?.toSymbol;
    expect(hit("a.ts#Shadow.use")).toBe("a.ts#Foo.hit");
    expect(hit("a.ts#Static.use")).toBeUndefined();
    expect(hit("a.ts#Rewritten.use")).toBeUndefined();
    expect(hit("a.ts#Nested.use")).toBeUndefined();
    expect(hit("a.ts#Readonly.use")).toBe("a.ts#Foo.hit");
    expect(hit("a.ts#typed")).toBe("lib.ts#Reader.hit");
  });

  it("keeps type-only imports out of constructor fields and lets same-name fields shadow methods", async () => {
    const index = await build({
      "lib.ts": "export class Foo { hit() {} }\n",
      "a.ts": "import type { Foo } from './lib.js';\nclass H { constructor() { this.x = new Foo(); } use() { this.x.hit(); } }\nclass Shadowed { hit() {} hit = 0; }\nclass Nested { inner() {} hit = () => { function inner() {} inner(); }; }\nfunction use(s: Shadowed) { s.hit(); }\n",
    });
    expect(index.outgoing("a.ts#H.use").find((edge) => edge.toName === "hit")?.toSymbol).toBeUndefined();
    expect(index.outgoing("a.ts#use").find((edge) => edge.toName === "hit")?.toSymbol).toBeUndefined();
    expect(index.outgoing("a.ts#Nested.hit").find((edge) => edge.toName === "inner")?.toSymbol).toBe("a.ts#Nested.hit.inner");
    const js = await build({ "a.js": "class H { hit() {} hit = 0; }\nclass G { hit = function* () { yield 1; }; }\nfunction use() {\n  const x = new H();\n  x.hit();\n  const g = new G();\n  g.hit();\n}\n" });
    expect([...index.symbols.keys()].length).toBeGreaterThan(0);
    expect(js.outgoing("a.js#use").filter((edge) => edge.toName === "hit").map((edge) => edge.toSymbol)).toEqual([undefined, "a.js#G.hit"]);
  });

  it("finds inherited members in Python and through constructor-assigned fields", async () => {
    const index = await build({
      "base.py": "class Base:\n    def send(self):\n        return 1\n",
      "app.py": "from base import Base\nimport base as mod\n\nclass Child(Base):\n    pass\n\nclass Dotted(mod.Base):\n    pass\n\nclass Holder:\n    def __init__(self):\n        self.child = Child()\n        self.other = make()\n\n    def run(self):\n        a = self.child.send()\n        return a + self.other.send()\n\n    def reset(self):\n        self.child = None\n\nclass Stable:\n    def __init__(self):\n        self.child = Child()\n\n    def run(self):\n        return self.child.send()\n\ndef use(c: Child, d: Dotted):\n    return c.send() + d.send()\n\ndef make():\n    return None\n",
    });
    expect(index.symbols.get("app.py#Child")?.heritage).toEqual([{ kind: "import", source: "base", importedName: "Base" }]);
    const use = [...index.outgoing("app.py#use").filter((edge) => edge.toName === "send")].sort((a, b) => a.line - b.line);
    expect(use.map((edge) => edge.toSymbol)).toEqual(["base.py#Base.send", "base.py#Base.send"]);
    expect(index.outgoing("app.py#Holder.run").filter((edge) => edge.toName === "send").map((edge) => edge.toSymbol)).toEqual([undefined, undefined]);
    const stable = index.outgoing("app.py#Stable.run").find((edge) => edge.toName === "send");
    expect(stable?.toSymbol).toBe("base.py#Base.send");
    expect(stable?.evidence).toMatchObject({ resolution: { method: "receiver-hint", receiver: { classSymbol: "app.py#Child", basis: "constructor" } } });
  });

  it("resolves TypeScript constructor-assigned fields", async () => {
    const index = await build({
      "program.ts": "export class Program { analyze() { return 1; } }\n",
      "a.ts": "import { Program } from './program.js';\nexport class A {\n  private _p;\n  private _q;\n  constructor() { this._p = new Program(); this._q = new Program(); }\n  m() { return this._p.analyze(); }\n  n() { this._q = other(); return this._q.analyze(); }\n}\nfunction other(): any { return null; }\n",
    });
    expect(index.outgoing("a.ts#A.m").find((edge) => edge.toName === "analyze")?.toSymbol).toBe("program.ts#Program.analyze");
    expect(index.outgoing("a.ts#A.n").find((edge) => edge.toName === "analyze")?.toSymbol).toBeUndefined();
  });

  it("uses TypeScript parameter annotations as instance receivers", async () => {
    const index = await build({
      "program.ts": "export class Program { analyze() { return 1; } }\n",
      "use.ts": "import { Program } from './program.js';\nimport * as ns from './program.js';\nexport function run(program: Program) { return program.analyze(); }\nexport function optional(p?: Program) { return p?.analyze(); }\nexport function nullable(p: Program | undefined) { return p!.analyze(); }\nexport function dotted(p: ns.Program) { return p.analyze(); }\nexport const arrow = (p: Program) => p.analyze();\nexport function generic(p: Set<Program>) { return p.analyze(); }\nexport function reassigned(p: Program) { p = other(); return p.analyze(); }\nexport function untyped(p) { return p.analyze(); }\nfunction other(): any { return null; }\n",
    });
    const hit = (name: string) => index.outgoing(`use.ts#${name}`).find((edge) => edge.toName === "analyze");
    for (const name of ["run", "optional", "nullable", "dotted", "arrow"]) {
      expect(hit(name)?.toSymbol, name).toBe("program.ts#Program.analyze");
      expect(hit(name)?.evidence, name).toMatchObject({ resolution: { method: "receiver-hint", receiver: { classSymbol: "program.ts#Program", mode: "instance", basis: "annotation" } } });
    }
    for (const name of ["generic", "reassigned", "untyped"]) expect(hit(name)?.toSymbol, name).toBeUndefined();
  });

  it("uses TypeScript field and local annotations as instance receivers", async () => {
    const index = await build({
      "program.ts": "export class Program { analyze() { return 1; } }\n",
      "a.ts": "import { Program } from './program.js';\nexport class A {\n  private _p: Program;\n  readonly maybe: Program | undefined;\n  constructor(private q: Program, public r?: Program) { this._p = new Program(); }\n  m() { return this._p.analyze(); }\n  n() { return this.q.analyze(); }\n  o() { return this.r?.analyze(); }\n  u() { return this.maybe!.analyze(); }\n}\nexport function locals() {\n  const l: Program = make();\n  let v: Program | null = null;\n  v = make();\n  const first = l.analyze();\n  const second = v!.analyze();\n  return first + second;\n}\nexport function relet() { let w: Program = make(); w = other(); return w.analyze(); }\nfunction make(): any { return null; }\nfunction other(): any { return null; }\n",
    });
    for (const name of ["A.m", "A.n", "A.o", "A.u"]) expect(index.outgoing(`a.ts#${name}`).find((edge) => edge.toName === "analyze")?.toSymbol, name).toBe("program.ts#Program.analyze");
    const local = index.outgoing("a.ts#locals").filter((edge) => edge.toName === "analyze").sort((a, b) => a.line - b.line);
    expect(local.map((edge) => edge.toSymbol)).toEqual(["program.ts#Program.analyze", undefined]);
    expect(index.outgoing("a.ts#relet").find((edge) => edge.toName === "analyze")?.toSymbol).toBeUndefined();
  });

  it("indexes interface members and resolves calls on interface-typed receivers", async () => {
    const index = await build({
      "runner.ts": "export interface Runner { run(): void; count: number; }\nexport function go(r: Runner) { r.run(); }\n",
    });
    expect(index.symbols.get("runner.ts#Runner.run")).toMatchObject({ kind: "method", memberKind: "instance" });
    expect(index.symbols.has("runner.ts#Runner.count")).toBe(false);
    const edge = index.outgoing("runner.ts#go")[0];
    expect(edge?.toSymbol).toBe("runner.ts#Runner.run");
    expect(edge?.evidence).toMatchObject({ resolution: { method: "receiver-hint", receiver: { classSymbol: "runner.ts#Runner", basis: "annotation" } } });
  });

  it("resolves a Python method whose overload declarations are decorated", async () => {
    const index = await build({
      "core.py": "import typing as t\n\nclass Context:\n    @t.overload\n    def invoke(self, callback: int) -> int: ...\n    @t.overload\n    def invoke(self, callback: str) -> str: ...\n    def invoke(self, callback):\n        return callback\n\n    def forward(self, cmd):\n        return self.invoke(cmd)\n\nclass Command:\n    def invoke(self, ctx: Context):\n        return ctx.invoke(self.callback)\n",
    });
    expect(index.outgoing("core.py#Context.forward")[0]?.toSymbol).toBe("core.py#Context.invoke");
    expect(index.outgoing("core.py#Command.invoke")[0]?.toSymbol).toBe("core.py#Context.invoke");
    expect(index.incoming("core.py#Context.invoke").map((edge) => edge.fromSymbol).sort()).toEqual(["core.py#Command.invoke", "core.py#Context.forward"]);
  });

  it("trusts overload only when it is bound to typing", async () => {
    const index = await build({
      "local.py": "def overload(f):\n    return lambda *a: 7\n\nclass C:\n    @overload\n    def hit(self):\n        return 1\n\ndef use(c: C):\n    return c.hit()\n",
      "ext.py": "from typing_extensions import overload\n\nclass D:\n    @overload\n    def hit(self, x: int) -> int: ...\n    def hit(self, x):\n        return x\n\ndef use(d: D):\n    return d.hit(1)\n",
      "deleted.py": "class E:\n    def hit(self):\n        return 1\n\ndef paren(x: E):\n    del (x)\n    return x.hit()\n\ndef tuple_del(x: E, y: E):\n    del (x, y)\n    return y.hit()\n",
    });
    expect(index.outgoing("local.py#use")[0]?.toSymbol).toBeUndefined();
    expect(index.outgoing("ext.py#use")[0]?.toSymbol).toBe("ext.py#D.hit");
    expect(index.outgoing("deleted.py#paren")[0]?.toSymbol).toBeUndefined();
    expect(index.outgoing("deleted.py#tuple_del")[0]?.toSymbol).toBeUndefined();
    const more = await build({
      "m.py": "import typing as t\n\ndef wrap(f):\n    return lambda *a: 7\n\nclass F:\n    @t.overload.wrap\n    def hit(self):\n        return 1\n\nclass G:\n    other = 1\n    def hit(self):\n        return 1\n\ndef chained(f: F):\n    return f.hit()\n\ndef attr(g: G):\n    del g.other\n    return g.hit()\n",
    });
    expect(more.outgoing("m.py#chained")[0]?.toSymbol).toBeUndefined();
    expect(more.outgoing("m.py#attr").find((edge) => edge.toName === "hit")?.toSymbol).toBe("m.py#G.hit");
  });

  it("keeps annotated receivers honest under variadics, lambdas, deletion and foreign decorators", async () => {
    const index = await build({
      "core.py": "class C:\n    def hit(self):\n        return 1\n\ndef wrap(f):\n    return lambda *a: 7\n\nclass D:\n    def hit(self):\n        return 1\n    @wrap\n    def hit(self):\n        return 2\n",
      "use.py": "from core import C, D\n\ndef star(*xs: C):\n    return xs.hit()\n\ndef double(**xs: C):\n    return xs.hit()\n\ndef lam(x: C):\n    f = lambda x: x.hit()\n    return f\n\ndef deleted(x: C):\n    del x\n    return x.hit()\n\ndef decorated(d: D):\n    return d.hit()\n\ndef fine(x: C):\n    return x.hit()\n",
    });
    expect(index.outgoing("use.py#star")[0]?.toSymbol).toBeUndefined();
    expect(index.outgoing("use.py#double")[0]?.toSymbol).toBeUndefined();
    expect(index.outgoing("use.py#lam.f")[0]?.toSymbol ?? index.outgoing("use.py#lam")[0]?.toSymbol).toBeUndefined();
    expect(index.outgoing("use.py#deleted")[0]?.toSymbol).toBeUndefined();
    expect(index.outgoing("use.py#decorated")[0]?.toSymbol).toBeUndefined();
    expect(index.outgoing("use.py#fine")[0]?.toSymbol).toBe("core.py#C.hit");
  });

  it("uses a Python parameter annotation as an instance receiver", async () => {
    const index = await build({
      "core.py": "class Context:\n    def invoke(self, callback):\n        return callback()\n\nclass Command:\n    def invoke(self, ctx):\n        return ctx.invoke(self.callback)\n",
      "decorators.py": "from .core import Context\nimport core as mod\n\ndef new_func(ctx: Context, *args):\n    return ctx.invoke(args)\n\ndef dotted(ctx: mod.Context):\n    return ctx.invoke(None)\n\ndef untyped(ctx):\n    return ctx.invoke(None)\n\ndef optional(ctx: 'Context | None'):\n    return ctx.invoke(None)\n\ndef shadowed(ctx: Context):\n    ctx = object()\n    return ctx.invoke(None)\n",
    });
    const typed = index.outgoing("decorators.py#new_func")[0];
    expect(typed?.toSymbol).toBe("core.py#Context.invoke");
    expect(typed?.evidence).toMatchObject({ resolution: { method: "receiver-hint", receiver: { classSymbol: "core.py#Context", mode: "instance", basis: "annotation" } } });
    expect(index.outgoing("decorators.py#dotted")[0]?.toSymbol).toBe("core.py#Context.invoke");
    expect(index.outgoing("decorators.py#untyped")[0]?.toSymbol).toBeUndefined();
    expect(index.outgoing("decorators.py#optional")[0]?.toSymbol).toBeUndefined();
    expect(index.outgoing("decorators.py#shadowed")[0]?.toSymbol).toBeUndefined();
    expect(index.outgoing("core.py#Command.invoke")[0]?.toSymbol).toBeUndefined();
  });

  it("does not attach an unknown object to an unrelated same-name method", async () => {
    const index = await build({ "a.ts": "export class Known { send() {} }\nexport function caller(value: any) { value.send(); }\n" });
    expect(index.outgoing("a.ts#caller")[0]?.toSymbol).toBeUndefined();
    expect(index.outgoing("a.ts#caller")[0]?.evidence).toMatchObject({ resolution: { status: "unresolved", reason: "receiver-unresolved" } });
  });

  it("resolves lexical this against the enclosing class, not the method name", async () => {
    const index = await build({ "a.ts": "export class A { send() {} caller() { this.send(); } }\nexport class B { send() {} }\n" });
    expect(index.outgoing("a.ts#A.caller")[0]?.toSymbol).toBe("a.ts#A.send");
    expect(index.outgoing("a.ts#A.caller")[0]?.evidence).toMatchObject({ resolution: { method: "receiver-hint", receiver: { classSymbol: "a.ts#A", mode: "instance", basis: "lexical" } } });
  });

  it("inherits this in arrows but not nested ordinary functions", async () => {
    const index = await build({ "a.ts": "export class A { send() {} caller() { const arrow = () => this.send(); function dynamic() { this.send(); } return arrow; } }\n" });
    expect(index.outgoing("a.ts#A.caller.arrow")[0]?.toSymbol).toBe("a.ts#A.send");
    expect(index.outgoing("a.ts#A.caller.dynamic")[0]?.toSymbol).toBeUndefined();
  });

  it("uses constructor-site hints across imports and barrels", async () => {
    const index = await build({
      "impl.ts": "export class A { send() {} }\n", "front.ts": "export { A as Client } from './impl.js';\n",
      "use.ts": "import { Client } from './front.js';\nexport function caller() { const x = new Client(); x.send(); }\n",
    });
    const edge = index.outgoing("use.ts#caller").find((item) => item.toName === "send");
    expect(edge?.toSymbol).toBe("impl.ts#A.send");
    expect(edge?.evidence).toMatchObject({ resolution: { method: "receiver-hint", receiver: { basis: "constructor" }, via: [{ file: "front.ts" }] } });
  });

  it("keeps static and instance receivers distinct in JavaScript", async () => {
    const index = await build({ "a.js": "export class A { static make() {} run() {} }\nexport function caller() { A.make(); A.run(); const x = new A(); x.run(); x.make(); }\n" });
    const edges = index.outgoing("a.js#caller");
    expect(edges.filter((edge) => edge.toName === "make").map((edge) => edge.toSymbol)).toEqual(expect.arrayContaining(["a.js#A.make", undefined]));
    expect(edges.filter((edge) => edge.toName === "run").map((edge) => edge.toSymbol)).toEqual(expect.arrayContaining(["a.js#A.run", undefined]));
  });

  it("does not infer a class from a factory call or a reassigned instance, but does from an annotation", async () => {
    const index = await build({ "a.ts": "export class A { send() {} }\nfunction factory() { return new A(); }\nexport function caller(value: A) {\n  value.send();\n  const x = factory();\n  x.send();\n  let y = new A();\n  y = value;\n  y.send();\n}\n" });
    const sends = index.outgoing("a.ts#caller").filter((edge) => edge.toName === "send").sort((a, b) => a.line - b.line);
    expect(sends.map((edge) => edge.toSymbol)).toEqual(["a.ts#A.send", undefined, undefined]);
  });

  it("resolves an immediate constructor receiver", async () => {
    const index = await build({ "a.ts": "export class A { send() {} }\nexport function caller() { (new A()).send(); }\n" });
    expect(index.outgoing("a.ts#caller").find((edge) => edge.toName === "send")?.toSymbol).toBe("a.ts#A.send");
  });

  it("does not call a getter as though it were the returned callable", async () => {
    const index = await build({ "a.ts": "export class A { get send() { return () => 1; } }\nexport function caller() { const x = new A(); x.send(); }\n" });
    expect(index.outgoing("a.ts#caller").find((edge) => edge.toName === "send")?.toSymbol).toBeUndefined();
  });

  it("uses Python self rather than competing class names", async () => {
    const index = await build({ "a.py": "class A:\n    def send(self):\n        pass\n    def caller(self):\n        self.send()\n\nclass B:\n    def send(self):\n        pass\n" });
    expect(index.outgoing("a.py#A.caller")[0]?.toSymbol).toBe("a.py#A.send");
  });

  it("recognizes Python constructor assignments and classmethod receivers", async () => {
    const index = await build({ "a.py": "class A:\n    def send(self):\n        pass\n    @classmethod\n    def make(cls):\n        pass\n    @classmethod\n    def caller(cls):\n        cls.make()\n\ndef use():\n    x = A()\n    x.send()\n" });
    expect(index.outgoing("a.py#A.caller")[0]?.toSymbol).toBe("a.py#A.make");
    expect(index.outgoing("a.py#use").find((edge) => edge.toName === "send")?.toSymbol).toBe("a.py#A.send");
  });

  it("does not assign lexical self to a staticmethod parameter or rebound self", async () => {
    const index = await build({ "a.py": "class A:\n    def send(self):\n        pass\n    @staticmethod\n    def plain(self):\n        self.send()\n    def rebound(self, other):\n        self = other\n        self.send()\n" });
    expect(index.outgoing("a.py#A.plain")[0]?.toSymbol).toBeUndefined();
    expect(index.outgoing("a.py#A.rebound")[0]?.toSymbol).toBeUndefined();
  });

  it("follows declared inheritance but not custom decorators or colliding member IDs", async () => {
    const index = await build({
      "a.ts": "export class Base { send() {} }\nexport class Child extends Base {}\nexport class Mixed { static run() {} run() {} }\nexport function caller() { const x = new Child(); x.send(); Mixed.run(); }\n",
      "a.py": "class A:\n    @custom\n    def send(self):\n        pass\n\ndef caller():\n    x = A()\n    x.send()\n",
    });
    const sends = index.outgoing("a.ts#caller").filter((edge) => ["send", "run"].includes(edge.toName));
    expect(sends.find((edge) => edge.toName === "send")?.toSymbol).toBe("a.ts#Base.send");
    expect(sends.find((edge) => edge.toName === "run")?.toSymbol).toBeUndefined();
    expect(index.outgoing("a.py#caller").find((edge) => edge.toName === "send")?.toSymbol).toBeUndefined();
  });

  it("preserves receiver hints through reload and changed-class resolution", async () => {
    const index = await build({ "a.ts": "export class A { send() {} }\n", "use.ts": "import { A } from './a.js';\nexport function caller() { const x = new A(); x.send(); }\n" });
    const loaded = await loadIndex(workspace, { cacheDir });
    expect(index.outgoing("use.ts#caller").find((edge) => edge.toName === "send")?.evidence).toMatchObject({ resolution: { method: "receiver-hint" } });
    expect(loaded?.edges).toEqual(index.edges);
    await fs.writeFile(path.join(workspace, "a.ts"), "export class A { other() {} }\n");
    const updated = await applyChanges(loaded ?? index, workspace, ["a.ts"]);
    expect(updated.outgoing("use.ts#caller").find((edge) => edge.toName === "send")?.toSymbol).toBeUndefined();
    expect(serializeArtifact(updated)).toEqual(serializeArtifact(await buildIndex(workspace, { cacheDir })));
  });

  it("uses class this inside a static getter body", async () => {
    const index = await build({ "a.ts": "export class A { static make() {} static get value() { return this.make(); } }\n" });
    expect(index.outgoing("a.ts#A.value")[0]?.toSymbol).toBe("a.ts#A.make");
  });

  it("does not trust shadowed Python builtin decorator names", async () => {
    const index = await build({ "a.py": "def classmethod(value):\n    return custom(value)\n\nclass A:\n    @classmethod\n    def send(cls):\n        pass\n    @classmethod\n    def caller(cls):\n        cls.send()\n\ndef outside():\n    A.send()\n" });
    expect(index.outgoing("a.py#A.caller")[0]?.toSymbol).toBeUndefined();
    expect(index.outgoing("a.py#outside")[0]?.toSymbol).toBeUndefined();
  });

  it("does not use an instance before its local initialization", async () => {
    const index = await build({ "a.ts": "export class A { send() {} }\nexport function caller() { x.send(); const x = new A(); x.send(); }\n" });
    expect(index.outgoing("a.ts#caller").filter((edge) => edge.toName === "send").map((edge) => edge.toSymbol)).toEqual(expect.arrayContaining([undefined, "a.ts#A.send"]));
  });

  it("does not use a declared method after an explicit local property write", async () => {
    const index = await build({ "a.ts": "export class A { send() {} keep() {} }\nexport function caller() { const x = new A(); x.send = replacement; x.send(); x.keep(); }\n" });
    const edges = index.outgoing("a.ts#caller");
    expect(edges.find((edge) => edge.toName === "send")?.toSymbol).toBeUndefined();
    expect(edges.find((edge) => edge.toName === "keep")?.toSymbol).toBe("a.ts#A.keep");
  });

  it("blocks local this/self method overwrites", async () => {
    const index = await build({
      "a.ts": "export class A { send() {} caller() { this.send = replacement; this.send(); } }\n",
      "a.py": "class A:\n    def send(self):\n        pass\n    def caller(self):\n        self.send = replacement\n        self.send()\n",
    });
    expect(index.outgoing("a.ts#A.caller")[0]?.toSymbol).toBeUndefined();
    expect(index.outgoing("a.py#A.caller")[0]?.toSymbol).toBeUndefined();
  });

  it("rejects malformed receiver metadata", async () => {
    const index = await build({ "a.ts": "export class A { send() {} caller() { this.send(); } }\n" });
    const sections = serializeSections(index);
    const lines = sections.edges.bytes.toString("utf8").slice(0, -1).split("\n");
    const header = JSON.parse(lines[0]!) as { bindings: unknown[] };
    header.bindings.push({ kind: "member", owner: { kind: "instance", owner: {} }, member: "send", mode: "instance", basis: "lexical" });
    lines[0] = JSON.stringify(header);
    const edgeBytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    const data = JSON.parse(sections.core.toString()) as { edgesHash: string; edgesBytes: number };
    data.edgesHash = sha256Hex(edgeBytes);
    data.edgesBytes = edgeBytes.length;
    expect(() => deserializeArtifact(JSON.stringify(data), undefined, sections.text.bytes, edgeBytes)).toThrow(/corrupt binding/);
  });

  it("uses Python class-body annotations and property return types as field receivers", async () => {
    const index = await build({
      "conn.py": "class Conn:\n    def send(self):\n        pass\n",
      "app.py": "from conn import Conn\nimport conn as mod\n\nclass Holder:\n    conn: Conn\n    other: mod.Conn = make()\n    count = 0\n    twice: Conn\n\n    def __init__(self):\n        self.conn = Conn()\n\n    @property\n    def link(self) -> Conn:\n        return self.conn\n\n    @property\n    def quoted(self) -> 'Conn':\n        return self.conn\n\n    def run(self):\n        self.conn.send()\n        self.other.send()\n        self.link.send()\n        self.count.send()\n        self.quoted.send()\n        self.twice.send()\n\n    def reset(self):\n        self.twice = None\n\ndef make():\n    return None\n",
    });
    const sends = [...index.outgoing("app.py#Holder.run").filter((edge) => edge.toName === "send")].sort((a, b) => a.line - b.line).map((edge) => edge.toSymbol);
    expect(sends).toEqual(["conn.py#Conn.send", "conn.py#Conn.send", "conn.py#Conn.send", undefined, undefined, "conn.py#Conn.send"]);
  });
});

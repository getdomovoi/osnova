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
  it("resolves a Python method whose overload declarations are decorated", async () => {
    const index = await build({
      "core.py": "import typing as t\n\nclass Context:\n    @t.overload\n    def invoke(self, callback: int) -> int: ...\n    @t.overload\n    def invoke(self, callback: str) -> str: ...\n    def invoke(self, callback):\n        return callback\n\n    def forward(self, cmd):\n        return self.invoke(cmd)\n\nclass Command:\n    def invoke(self, ctx: Context):\n        return ctx.invoke(self.callback)\n",
    });
    expect(index.outgoing("core.py#Context.forward")[0]?.toSymbol).toBe("core.py#Context.invoke");
    expect(index.outgoing("core.py#Command.invoke")[0]?.toSymbol).toBe("core.py#Context.invoke");
    expect(index.incoming("core.py#Context.invoke").map((edge) => edge.fromSymbol).sort()).toEqual(["core.py#Command.invoke", "core.py#Context.forward"]);
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

  it("does not infer a class from a factory call, annotation or reassigned instance", async () => {
    const index = await build({ "a.ts": "export class A { send() {} }\nfunction factory() { return new A(); }\nexport function caller(value: A) { value.send(); const x = factory(); x.send(); let y = new A(); y = value; y.send(); }\n" });
    expect(index.outgoing("a.ts#caller").filter((edge) => edge.toName === "send").every((edge) => edge.toSymbol === undefined)).toBe(true);
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

  it("does not guess through inheritance, custom decorators or colliding member IDs", async () => {
    const index = await build({
      "a.ts": "export class Base { send() {} }\nexport class Child extends Base {}\nexport class Mixed { static run() {} run() {} }\nexport function caller() { const x = new Child(); x.send(); Mixed.run(); }\n",
      "a.py": "class A:\n    @custom\n    def send(self):\n        pass\n\ndef caller():\n    x = A()\n    x.send()\n",
    });
    expect(index.outgoing("a.ts#caller").filter((edge) => ["send", "run"].includes(edge.toName)).every((edge) => edge.toSymbol === undefined)).toBe(true);
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
});

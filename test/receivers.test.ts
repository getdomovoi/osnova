import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex, applyChanges, loadIndex, serializeArtifact } from "../src/index.js";
import { deserializeArtifact } from "../src/index/serialize.js";
import { serializeText } from "../src/index/textStore.js";

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
    const artifact = JSON.parse(serializeArtifact(index).toString()) as { edges: Array<{ b: unknown }> };
    const edge = artifact.edges[0];
    if (edge === undefined) throw new Error("expected call");
    edge.b = { kind: "member", owner: { kind: "instance", owner: {} }, member: "send", mode: "instance", basis: "lexical" };
    expect(() => deserializeArtifact(JSON.stringify(artifact), undefined, serializeText(index).bytes)).toThrow(/corrupt binding/);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex, applyChanges, callersDetailed, loadIndex, serializeArtifact } from "../src/index.js";
import { deserializeArtifact, serializeSections } from "../src/index/serialize.js";
import { sha256Hex } from "../src/index/scan.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-bindings-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
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

describe("import bindings", () => {
  it.each(["ts", "tsx", "js"])("resolves named aliases and constructors in %s", async (extension) => {
    const index = await build({
      [`api.${extension}`]: "export function transmit() {}\nexport class Endpoint {}\n",
      [`client.${extension}`]: `import { transmit as send, Endpoint as Client } from './api.${extension}';\nexport function deliver() { send(); return new Client(); }\n`,
    });
    const calls = index.outgoing(`client.${extension}#deliver`);
    expect(calls.find((edge) => edge.toName === "send")?.toSymbol).toBe(`api.${extension}#transmit`);
    expect(calls.find((edge) => edge.toName === "Client")?.toSymbol).toBe(`api.${extension}#Endpoint`);
    expect(calls[0]?.evidence).toMatchObject({ resolution: { status: "resolved", method: "import-binding" } });
  });

  it("does not connect parameter or destructuring shadows to an import", async () => {
    const index = await build({
      "api.ts": "export function transmit() {}\n",
      "client.ts": "import { transmit as send } from './api.js';\nexport function plain() { send(); }\nexport function parameter(send: () => void) { send(); }\nexport function destructured({ send }: { send: () => void }) { send(); }\n",
    });
    const result = callersDetailed(index, "api.ts#transmit");
    if (result.status !== "found") throw new Error("expected target");
    expect(result.hits.map((hit) => hit.qualifiedName)).toEqual(["client.ts#plain"]);
    expect(index.outgoing("client.ts#parameter")[0]?.toSymbol).toBeUndefined();
    expect(index.outgoing("client.ts#destructured")[0]?.toSymbol).toBeUndefined();
  });

  it("respects block let bindings and function-scoped var hoisting", async () => {
    const index = await build({
      "api.ts": "export function transmit() {}\n",
      "client.ts": "import { transmit as send } from './api.js';\nexport function blocks() {\n  { send(); let send = () => 1; }\n  send();\n}\nexport function hoisted() { send(); { var send = () => 1; } }\n",
    });
    const calls = index.outgoing("client.ts#blocks").filter((edge) => edge.toName === "send");
    expect(calls.map((edge) => edge.toSymbol)).toEqual([undefined, "api.ts#transmit"]);
    expect(index.outgoing("client.ts#hoisted")[0]?.toSymbol).toBeUndefined();
  });

  it("keeps imported module identity instead of falling back to a same-name global", async () => {
    const index = await build({
      "api.ts": "export function run() {}\n",
      "client.ts": "import { run } from 'missing-package';\nexport function caller() { run(); }\n",
    });
    expect(index.outgoing("client.ts#caller")[0]?.toSymbol).toBeUndefined();
  });

  it("honors named export aliases and refuses private module declarations", async () => {
    const index = await build({
      "api.ts": "function internal() {}\nfunction secret() {}\nexport { internal as transmit };\n",
      "client.ts": "import { transmit as send, secret } from './api.js';\nexport function caller() { send(); secret(); }\n",
    });
    const edges = index.outgoing("client.ts#caller");
    expect(edges.find((edge) => edge.toName === "send")?.toSymbol).toBe("api.ts#internal");
    expect(edges.find((edge) => edge.toName === "secret")?.toSymbol).toBeUndefined();
  });

  it("does not treat a type-only import as a runtime callable", async () => {
    const index = await build({
      "api.ts": "export class Endpoint {}\n",
      "client.ts": "import type { Endpoint as Client } from './api.js';\nexport function caller() { return new Client(); }\n",
    });
    expect(index.outgoing("client.ts#caller")[0]?.toSymbol).toBeUndefined();
  });

  it("attributes calls inside module-level arrow declarations to that definition", async () => {
    const index = await build({
      "api.ts": "export function transmit() {}\n",
      "client.ts": "import { transmit as send } from './api.js';\nexport const caller = () => send();\n",
    });
    expect(index.outgoing("client.ts#caller")[0]?.toSymbol).toBe("api.ts#transmit");
  });

  it("resolves Python aliases and treats later assignments as function-local", async () => {
    const index = await build({
      "pkg/api.py": "def transmit():\n    return 1\n",
      "pkg/client.py": "from .api import transmit as send\n\ndef caller():\n    return send()\n\ndef shadow(send):\n    return send()\n\ndef later():\n    value = send()\n    send = lambda: 1\n    return value\n",
    });
    expect(index.outgoing("pkg/client.py#caller")[0]?.toSymbol).toBe("pkg/api.py#transmit");
    expect(index.outgoing("pkg/client.py#shadow")[0]?.toSymbol).toBeUndefined();
    expect(index.outgoing("pkg/client.py#later")[0]?.toSymbol).toBeUndefined();
  });

  it("resolves Python default-argument calls in the outer scope", async () => {
    const index = await build({
      "pkg/api.py": "def transmit():\n    return 1\n",
      "pkg/client.py": "from .api import transmit as send\n\ndef caller(send=send()):\n    return send()\n",
    });
    const calls = index.edges.filter((edge) => edge.fromFile === "pkg/client.py" && edge.kind === "calls");
    expect(calls.map((edge) => edge.toSymbol)).toEqual(["pkg/api.py#transmit", undefined]);
  });

  it("does not capture Python class attributes as method lexical bindings", async () => {
    const index = await build({
      "pkg/api.py": "def transmit():\n    return 1\n",
      "pkg/client.py": "from .api import transmit as send\n\nclass Wrapper:\n    send = 1\n    def caller(self):\n        return send()\n",
    });
    expect(index.outgoing("pkg/client.py#Wrapper.caller")[0]?.toSymbol).toBe("pkg/api.py#transmit");
  });

  it("persists binding evidence and re-resolves unchanged importers after target edits", async () => {
    const index = await build({
      "api.ts": "export function transmit() {}\n",
      "client.ts": "import { transmit as send } from './api.js';\nexport function caller() { send(); }\n",
    });
    const loaded = await loadIndex(workspace, { cacheDir });
    expect(index.outgoing("client.ts#caller")[0]?.toSymbol).toBe("api.ts#transmit");
    expect(loaded?.edges).toEqual(index.edges);
    await fs.writeFile(path.join(workspace, "api.ts"), "export function other() {}\n");
    const updated = await applyChanges(loaded ?? index, workspace, ["api.ts"]);
    expect(updated.outgoing("client.ts#caller")[0]?.toSymbol).toBeUndefined();
    expect(serializeArtifact(updated)).toEqual(serializeArtifact(await buildIndex(workspace, { cacheDir })));
  });

  it("does not resolve an unbound bare name to an unrelated method", async () => {
    const index = await build({ "a.ts": "export class A { send() {} }\nexport function caller() { send(); }\n" });
    expect(index.outgoing("a.ts#caller")[0]?.toSymbol).toBeUndefined();
  });

  it("handles loop and catch bindings without shadowing the enclosing scope", async () => {
    const index = await build({
      "api.ts": "export function transmit() {}\n",
      "client.ts": "import { transmit as send } from './api.js';\nexport function caller() {\n  for (const send of values) { send(); }\n  try {} catch(send) { send(); }\n  send();\n}\n",
    });
    expect(index.outgoing("client.ts#caller").filter((edge) => edge.toName === "send").map((edge) => edge.toSymbol)).toEqual([undefined, undefined, "api.ts#transmit"]);
  });

  it("captures Python with/except targets as function-local names", async () => {
    const index = await build({
      "pkg/api.py": "def transmit():\n    return 1\n",
      "pkg/client.py": "from .api import transmit as send\n\ndef context():\n    with manager() as send:\n        send()\n\ndef caught():\n    try:\n        pass\n    except Error as send:\n        send()\n",
    });
    expect(index.outgoing("pkg/client.py#context").find((edge) => edge.toName === "send")?.toSymbol).toBeUndefined();
    expect(index.outgoing("pkg/client.py#caught").find((edge) => edge.toName === "send")?.toSymbol).toBeUndefined();
  });

  it("resolves named defaults and direct namespace members while honoring shadows", async () => {
    const index = await build({
      "api.ts": "export default class Engine {}\nexport function transmit() {}\n",
      "client.ts": "import Client from './api.js';\nimport * as wire from './api.js';\nexport function caller() { wire.transmit(); return new Client(); }\nexport function shadow(wire: any) { wire.transmit(); }\n",
    });
    expect(index.outgoing("client.ts#caller").map((edge) => edge.toSymbol)).toEqual(expect.arrayContaining(["api.ts#transmit", "api.ts#Engine"]));
    expect(index.outgoing("client.ts#shadow")[0]?.toSymbol).toBeUndefined();
  });

  it("does not infer a stable alias after rebinding", async () => {
    const index = await build({
      "api.ts": "export function transmit() {}\n",
      "client.ts": "import { transmit as send } from './api.js';\nexport function caller() { send = replacement; send(); }\n",
    });
    expect(index.outgoing("client.ts#caller")[0]?.toSymbol).toBeUndefined();
  });

  it("keeps same-line calls with distinct binding states through incremental updates", async () => {
    const index = await build({ "pkg/client.py": "from .api import transmit as send\ndef caller(send=send()): return send()\n" });
    expect(index.outgoing("pkg/client.py#caller").filter((edge) => edge.kind === "calls")).toHaveLength(2);
    await fs.writeFile(path.join(workspace, "pkg/api.py"), "def transmit():\n    return 1\n");
    const updated = await applyChanges(index, workspace, ["pkg/api.py"]);
    expect(serializeArtifact(updated)).toEqual(serializeArtifact(await buildIndex(workspace, { cacheDir })));
  });

  it("blocks destructuring reassignment of a JavaScript import", async () => {
    const index = await build({ "api.js": "export function transmit() {}\n", "client.js": "import { transmit as send } from './api.js';\nexport function caller() { ({send} = other); send(); }\n" });
    expect(index.outgoing("client.js#caller")[0]?.toSymbol).toBeUndefined();
  });

  it("does not resolve deleted or match-bound Python locals through imports", async () => {
    const index = await build({
      "pkg/api.py": "def transmit():\n    return 1\n",
      "pkg/client.py": "from .api import transmit as send\n\ndef deleted():\n    send()\n    del send\n\ndef matched(value):\n    match value:\n        case send:\n            send()\n",
    });
    expect(index.outgoing("pkg/client.py#deleted")[0]?.toSymbol).toBeUndefined();
    expect(index.outgoing("pkg/client.py#matched")[0]?.toSymbol).toBeUndefined();
  });

  it("skips all enclosing Python class namespaces when resolving method closures", async () => {
    const index = await build({
      "pkg/api.py": "def transmit():\n    return 1\n",
      "pkg/client.py": "from .api import transmit as send\n\nclass Outer:\n    send = 1\n    class Inner:\n        def caller(self):\n            return send()\n",
    });
    expect(index.outgoing("pkg/client.py#Outer.Inner.caller")[0]?.toSymbol).toBe("pkg/api.py#transmit");
  });

  it("rejects malformed persisted binding hints", async () => {
    const index = await build({ "a.ts": "export function repeat() { repeat(); }\n" });
    const sections = serializeSections(index);
    const lines = sections.edges.bytes.toString("utf8").slice(0, -1).split("\n");
    const header = JSON.parse(lines[0]!) as { bindings: unknown[] };
    header.bindings.push({ kind: "import", source: 42, importedName: "repeat" });
    lines[0] = JSON.stringify(header);
    const edgeBytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    const data = JSON.parse(sections.core.toString()) as { edgesHash: string; edgesBytes: number };
    data.edgesHash = sha256Hex(edgeBytes);
    data.edgesBytes = edgeBytes.length;
    expect(() => deserializeArtifact(JSON.stringify(data), undefined, sections.text.bytes, edgeBytes)).toThrow(/corrupt binding/);
  });

  it("does not expose a type-only class export as a runtime value", async () => {
    const index = await build({
      "api.ts": "class Endpoint {}\nexport type { Endpoint };\n",
      "client.ts": "import { Endpoint } from './api.js';\nexport function caller() { return new Endpoint(); }\n",
    });
    expect(index.outgoing("client.ts#caller")[0]?.toSymbol).toBeUndefined();
  });

  it("unwraps parenthesized aliases without guessing returned-callable identities", async () => {
    const index = await build({
      "api.ts": "export function factory() { return () => 1; }\n",
      "client.ts": "import { factory as make } from './api.js';\nexport function caller() { (make)(); make()(); }\n",
    });
    const calls = index.outgoing("client.ts#caller");
    expect(calls.some((edge) => edge.toSymbol === "api.ts#factory")).toBe(true);
    expect(calls.some((edge) => edge.binding?.kind === "blocked" && edge.toSymbol === undefined)).toBe(true);
  });

  it("records Python namespace import modules without alias text", async () => {
    const index = await build({
      "pkg/api.py": "def transmit():\n    return 1\n",
      "pkg/client.py": "import pkg.api as wire\n\ndef caller():\n    return wire.transmit()\n",
    });
    expect(index.edges.find((edge) => edge.fromFile === "pkg/client.py" && edge.kind === "imports")).toMatchObject({ toName: "pkg.api", toFile: "pkg/api.py" });
    expect(index.outgoing("pkg/client.py#caller")[0]?.toSymbol).toBe("pkg/api.py#transmit");
  });
});

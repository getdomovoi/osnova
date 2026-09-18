import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";

let temporary: string;
beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-unwrap-")); });
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });
async function build(files: Record<string, string>) {
  const root = path.join(temporary, "ws"); await fs.mkdir(root);
  for (const [name, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); }
  return buildIndex(root, { cacheDir: path.join(temporary, "cache") });
}
const hits = (index: Awaited<ReturnType<typeof build>>, symbol: string, name = "hit") =>
  [...index.outgoing(symbol).filter((edge) => edge.toName === name)].sort((a, b) => a.line - b.line).map((edge) => edge.toSymbol);

describe("unwrapped receivers", () => {
  it("TypeScript: `await` names the value inside a Promise return type", async () => {
    const index = await build({
      "lib.ts": "export class Foo { hit() {} }\nexport async function load(): Promise<Foo> { return new Foo(); }\nexport function later(): Promise<Foo> { return load(); }\nexport async function vague() { return new Foo(); }\nexport class Box {\n  async open(): Promise<Foo> { return new Foo(); }\n  async self(): Promise<this> { return this; }\n}\n",
      "a.ts": "import { load, later, vague, Box } from './lib.js';\nexport async function use(b: Box) {\n  (await load()).hit();\n  const x = await load();\n  x.hit();\n  (await later()).hit();\n  later().hit();\n  load().hit();\n  (await vague()).hit();\n  (await b.open()).hit();\n  (await (await b.self()).open()).hit();\n  const y = await b.self();\n  (await y.open()).hit();\n}\n",
    });
    expect(index.symbols.get("lib.ts#load")).toMatchObject({ unwrapped: { kind: "local", name: "Foo" } });
    expect(index.symbols.get("lib.ts#load")?.returns).toBeUndefined();
    expect(index.symbols.get("lib.ts#later")).toMatchObject({ returns: { kind: "local", name: "Promise" }, unwrapped: { kind: "local", name: "Foo" } });
    expect(index.symbols.get("lib.ts#Box.self")?.unwrapped).toEqual({ kind: "this" });
    expect(hits(index, "a.ts#use")).toEqual(["lib.ts#Foo.hit", "lib.ts#Foo.hit", "lib.ts#Foo.hit", undefined, undefined, undefined, "lib.ts#Foo.hit", "lib.ts#Foo.hit", "lib.ts#Foo.hit"]);
    const first = index.outgoing("a.ts#use").find((edge) => edge.toName === "hit");
    expect(first?.binding).toEqual({ kind: "member", owner: { kind: "return", of: { kind: "import", source: "./lib.js", importedName: "load" }, unwrapped: true }, member: "hit", mode: "instance", basis: "return" });
  });

  it("Python: `await` on an async function follows its declared result", async () => {
    const index = await build({
      "lib.py": "class Foo:\n    def hit(self):\n        pass\n\nasync def load() -> Foo:\n    return Foo()\n\ndef sync() -> Foo:\n    return Foo()\n",
      "a.py": "from lib import load, sync\n\nasync def use():\n    (await load()).hit()\n    x = await load()\n    x.hit()\n    load().hit()\n    sync().hit()\n",
    });
    expect(index.symbols.get("lib.py#load")).toMatchObject({ unwrapped: { kind: "local", name: "Foo" } });
    expect(index.symbols.get("lib.py#load")?.returns).toBeUndefined();
    expect(hits(index, "a.py#use")).toEqual(["lib.py#Foo.hit", "lib.py#Foo.hit", undefined, "lib.py#Foo.hit"]);
  });

  it("Rust: `?`, `unwrap()` and `expect()` name the value inside Result and Option", async () => {
    const index = await build({
      "Cargo.toml": "[package]\nname = \"app\"\nversion = \"0.1.0\"\n",
      "src/lib.rs": "pub mod conn;\npub mod svc;\n",
      "src/conn.rs": "pub struct Conn;\nimpl Conn { pub fn hit(&self) {} }\npub fn open() -> Result<Conn, String> { Ok(Conn) }\npub fn find() -> Option<Conn> { Some(Conn) }\npub fn io() -> std::io::Result<Conn> { Ok(Conn) }\npub fn plain() -> Conn { Conn }\n",
      "src/svc.rs": "use crate::conn::{open, find, io, plain};\npub fn run() -> Result<(), String> {\n    open()?.hit();\n    let c = open()?;\n    c.hit();\n    find().unwrap().hit();\n    io().expect(\"io\").hit();\n    let d = find().unwrap();\n    d.hit();\n    open().hit();\n    plain().hit();\n    Ok(())\n}\n",
    });
    expect(index.symbols.get("src/conn.rs#open")).toMatchObject({ returns: { kind: "local", name: "Result" }, unwrapped: { kind: "local", name: "Conn" } });
    expect(index.symbols.get("src/conn.rs#io")?.unwrapped).toEqual({ kind: "local", name: "Conn" });
    expect(hits(index, "src/svc.rs#run")).toEqual(["src/conn.rs#Conn.hit", "src/conn.rs#Conn.hit", "src/conn.rs#Conn.hit", "src/conn.rs#Conn.hit", "src/conn.rs#Conn.hit", undefined, "src/conn.rs#Conn.hit"]);
  });
});

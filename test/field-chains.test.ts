import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";

let temporary: string;
beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-field-chains-")); });
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });
async function build(files: Record<string, string>) {
  const root = path.join(temporary, "ws"); await fs.mkdir(root);
  for (const [name, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); }
  return buildIndex(root, { cacheDir: path.join(temporary, "cache") });
}
const hits = (index: Awaited<ReturnType<typeof build>>, symbol: string, name = "hit") =>
  [...index.outgoing(symbol).filter((edge) => edge.toName === name)].sort((a, b) => a.line - b.line).map((edge) => edge.toSymbol);

describe("field chains", () => {
  it("TypeScript: a field declared in another file types `this.field.m()` and `param.field.m()`", async () => {
    const index = await build({
      "conn.ts": "export class Conn { hit() {} }\n",
      "pool.ts": "import { Conn } from './conn.js';\nexport class Pool {\n  conn: Conn;\n  constructor(readonly spare: Conn) { this.conn = spare; }\n}\nexport interface Holder { conn: Conn; count: number }\n",
      "use.ts": "import { Pool, Holder } from './pool.js';\nexport class Service {\n  constructor(private pool: Pool) {}\n  run(h: Holder, p: Pool) {\n    this.pool.conn.hit();\n    this.pool.spare.hit();\n    h.conn.hit();\n    h.count.hit();\n    p.conn.hit();\n    p.missing.hit();\n  }\n}\n",
    });
    expect(index.symbols.get("pool.ts#Pool")?.fieldTypes).toEqual({ conn: { kind: "import", source: "./conn.js", importedName: "Conn" }, spare: { kind: "import", source: "./conn.js", importedName: "Conn" } });
    expect(index.symbols.get("pool.ts#Holder")?.fieldTypes).toEqual({ conn: { kind: "import", source: "./conn.js", importedName: "Conn" } });
    expect(hits(index, "use.ts#Service.run")).toEqual(["conn.ts#Conn.hit", "conn.ts#Conn.hit", "conn.ts#Conn.hit", undefined, "conn.ts#Conn.hit", undefined]);
    const first = index.outgoing("use.ts#Service.run").find((edge) => edge.toName === "hit");
    expect(first?.binding).toEqual({ kind: "member", owner: { kind: "field", of: { kind: "field", of: { kind: "local", name: "Service" }, member: "pool" }, member: "conn" }, member: "hit", mode: "instance", basis: "annotation" });
    expect(first?.evidence).toMatchObject({ resolution: { method: "receiver-hint", receiver: { classSymbol: "conn.ts#Conn" } } });
  });

  it("TypeScript: inherited fields, call-result fields and reassigned fields", async () => {
    const index = await build({
      "a.ts": "class Conn { hit() {} }\nclass Base { conn: Conn = new Conn(); }\nclass Sub extends Base {}\nclass Twice { conn: Conn = new Conn(); constructor() { this.conn = new Conn(); this.conn = new Conn(); } go() { this.conn.hit(); } }\nfunction sub(): Sub { return new Sub(); }\nfunction use(s: Sub) {\n  s.conn.hit();\n  sub().conn.hit();\n  s.conn.conn.hit();\n}\n",
    });
    expect(hits(index, "a.ts#use")).toEqual(["a.ts#Conn.hit", "a.ts#Conn.hit", undefined]);
    expect(hits(index, "a.ts#Twice.go")).toEqual([undefined]);
  });

  it("Python: class-body annotations type attribute chains across files", async () => {
    const index = await build({
      "conn.py": "class Conn:\n    def hit(self):\n        pass\n",
      "pool.py": "from conn import Conn\n\nclass Pool:\n    conn: Conn\n    def __init__(self):\n        self.conn = Conn()\n",
      "use.py": "from pool import Pool\n\nclass Service:\n    pool: Pool\n    def run(self, p: Pool):\n        self.pool.conn.hit()\n        p.conn.hit()\n        p.other.hit()\n",
    });
    expect(index.symbols.get("pool.py#Pool")?.fieldTypes).toEqual({ conn: { kind: "import", source: "conn", importedName: "Conn" } });
    expect(hits(index, "use.py#Service.run")).toEqual(["conn.py#Conn.hit", "conn.py#Conn.hit", undefined]);
  });

  it("Go: struct fields type selector chains through the receiver and across packages", async () => {
    const index = await build({
      "go.mod": "module example.com/app\n\ngo 1.22\n",
      "conn/conn.go": "package conn\n\ntype Conn struct{}\n\nfunc (c *Conn) Hit() {}\n",
      "pool/pool.go": "package pool\n\nimport \"example.com/app/conn\"\n\ntype Pool struct {\n\tConn *conn.Conn\n\tName string\n}\n",
      "svc/svc.go": "package svc\n\nimport \"example.com/app/pool\"\n\ntype Service struct {\n\tpool *pool.Pool\n}\n\nfunc (s *Service) Run(p pool.Pool) {\n\ts.pool.Conn.Hit()\n\tp.Conn.Hit()\n\tp.Name.Hit()\n}\n",
    });
    expect(index.symbols.get("pool/pool.go#Pool")?.fieldTypes).toEqual({ Conn: { kind: "import", source: "example.com/app/conn", importedName: "Conn" }, Name: { kind: "local", name: "string" } });
    expect(hits(index, "svc/svc.go#Service.Run", "Hit")).toEqual(["conn/conn.go#Conn.Hit", "conn/conn.go#Conn.Hit", undefined]);
  });

  it("Rust: struct fields type field-expression chains", async () => {
    const index = await build({
      "Cargo.toml": "[package]\nname = \"app\"\nversion = \"0.1.0\"\n",
      "src/lib.rs": "pub mod conn;\npub mod pool;\npub mod svc;\n",
      "src/conn.rs": "pub struct Conn;\nimpl Conn { pub fn hit(&self) {} }\n",
      "src/pool.rs": "use crate::conn::Conn;\npub struct Pool { pub conn: Conn, pub name: String }\n",
      "src/svc.rs": "use crate::pool::Pool;\npub struct Service { pool: Pool }\nimpl Service {\n    pub fn run(&self, p: &Pool) {\n        self.pool.conn.hit();\n        p.conn.hit();\n        p.name.hit();\n    }\n}\n",
    });
    expect(index.symbols.get("src/pool.rs#Pool")?.fieldTypes).toEqual({ conn: { kind: "import", source: "crate::conn", importedName: "Conn" }, name: { kind: "local", name: "String" } });
    expect(hits(index, "src/svc.rs#Service.run")).toEqual(["src/conn.rs#Conn.hit", "src/conn.rs#Conn.hit", undefined]);
  });

  it("Java and C#: field declarations type member-access chains", async () => {
    const index = await build({
      "Conn.java": "package app;\npublic class Conn { public void hit() {} }\n",
      "Pool.java": "package app;\npublic class Pool { public Conn conn; public static Conn shared; }\n",
      "Service.java": "package app;\npublic class Service {\n  private Pool pool;\n  void run(Pool p) {\n    this.pool.conn.hit();\n    pool.conn.hit();\n    p.conn.hit();\n    p.shared.hit();\n  }\n}\n",
      "Conn.cs": "namespace App { public class Conn { public void Hit() {} } }\n",
      "Pool.cs": "namespace App { public class Pool { public Conn Conn { get; set; } public Conn field; } }\n",
      "Service.cs": "namespace App {\n  public class Service {\n    private Pool pool;\n    void Run(Pool p) {\n      this.pool.Conn.Hit();\n      pool.field.Hit();\n      p.Conn.Hit();\n    }\n  }\n}\n",
    });
    expect(index.symbols.get("Pool.java#Pool")?.fieldTypes).toEqual({ conn: { kind: "local", name: "Conn" } });
    expect(hits(index, "Service.java#Service.run")).toEqual(["Conn.java#Conn.hit", "Conn.java#Conn.hit", "Conn.java#Conn.hit", undefined]);
    expect(index.symbols.get("Pool.cs#Pool")?.fieldTypes).toEqual({ Conn: { kind: "local", name: "Conn" }, field: { kind: "local", name: "Conn" } });
    expect(hits(index, "Service.cs#Service.Run", "Hit")).toEqual(["Conn.cs#Conn.Hit", "Conn.cs#Conn.Hit", "Conn.cs#Conn.Hit"]);
  });
});

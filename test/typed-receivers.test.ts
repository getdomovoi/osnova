import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";

let temporary: string;
beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-typed-receivers-")); });
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });
async function build(files: Record<string, string>) {
  const root = path.join(temporary, "ws"); await fs.mkdir(root);
  for (const [name, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); }
  return buildIndex(root, { cacheDir: path.join(temporary, "cache") });
}
const calls = (index: Awaited<ReturnType<typeof build>>, symbol: string, name: string) =>
  [...index.outgoing(symbol).filter((edge) => edge.kind === "calls" && edge.toName === name)].sort((a, b) => a.line - b.line).map((edge) => edge.toSymbol);

describe("Go receivers", () => {
  it("binds typed parameters, locals, composite literals, constructor results and the method receiver", async () => {
    const index = await build({
      "server.go": "package a\n\ntype Server struct{ port int }\n\nfunc NewServer() *Server { return &Server{} }\n\nfunc (s *Server) Start() { s.Stop() }\n\nfunc (s *Server) Stop() {}\n",
      "use.go": "package a\n\nfunc use(s *Server, t Server, u Other) {\n  s.Start()\n  t.Start()\n  n := NewServer()\n  n.Start()\n  var v *Server\n  v.Start()\n  w := &Server{}\n  w.Start()\n  x := Server{}\n  x.Start()\n  NewServer().Start()\n  u.Start()\n  s = nil\n  y := unknown()\n  y.Start()\n  s.Start()\n}\n",
      "other.go": "package b\n\ntype Other struct{}\n",
    });
    expect(index.symbols.get("server.go#Server.Start")?.memberKind).toBe("instance");
    expect(index.symbols.get("server.go#NewServer")?.returns).toEqual({ kind: "local", name: "Server" });
    expect(calls(index, "server.go#Server.Start", "Stop")).toEqual(["server.go#Server.Stop"]);
    expect(calls(index, "use.go#use", "Start")).toEqual([
      undefined, "server.go#Server.Start", "server.go#Server.Start", "server.go#Server.Start", "server.go#Server.Start", "server.go#Server.Start", "server.go#Server.Start", undefined, undefined, undefined,
    ]);
  });

  it("stays unresolved when two Go types share a name", async () => {
    const index = await build({
      "a/server.go": "package a\n\ntype Server struct{}\n\nfunc (s *Server) Start() {}\n",
      "b/server.go": "package b\n\ntype Server struct{}\n\nfunc (s *Server) Start() {}\n",
      "c/use.go": "package c\n\nfunc use(s *Server) { s.Start() }\n",
    });
    expect(calls(index, "c/use.go#use", "Start")).toEqual([undefined]);
  });
});

describe("Rust receivers", () => {
  it("binds self, typed parameters, lets, struct literals, associated function results and paths", async () => {
    const index = await build({
      "Cargo.toml": "[package]\nname = 'x'\n",
      "src/server.rs": "pub struct Server { port: u16 }\n\nimpl Server {\n    pub fn new() -> Server { Server { port: 1 } }\n    pub fn build() -> Self { Server { port: 2 } }\n    pub fn start(&self) { self.stop(); }\n    pub fn stop(&mut self) {}\n}\n",
      "src/main.rs": "use crate::server::Server;\n\nfn run(s: &Server, t: Server, u: &mut Server) {\n    s.start();\n    t.start();\n    u.start();\n    let n = Server::new();\n    n.start();\n    let m: Server = t;\n    m.start();\n    let w = Server { port: 3 };\n    w.start();\n    Server::new().start();\n    Server::build().start();\n    Server::stop();\n    let z = other();\n    z.start();\n    let mut q = Server::new();\n    q = other();\n    q.start();\n}\n",
    });
    expect(index.symbols.get("src/server.rs#Server.new")?.memberKind).toBe("static");
    expect(index.symbols.get("src/server.rs#Server.start")?.memberKind).toBe("instance");
    expect(index.symbols.get("src/server.rs#Server.build")?.returns).toEqual({ kind: "this" });
    expect(calls(index, "src/server.rs#Server.start", "stop")).toEqual(["src/server.rs#Server.stop"]);
    expect(calls(index, "src/main.rs#run", "start")).toEqual([...Array.from({ length: 8 }, () => "src/server.rs#Server.start"), undefined, undefined]);
    expect(calls(index, "src/main.rs#run", "new")).toEqual(["src/server.rs#Server.new", "src/server.rs#Server.new", "src/server.rs#Server.new"]);
    expect(calls(index, "src/main.rs#run", "stop")).toEqual([undefined]);
  });

  it("resolves Go package imports through go.mod and finds methods across package files", async () => {
    const index = await build({
      "go.mod": "module example.com/app\n\ngo 1.22\n",
      "server/server.go": "package server\n\ntype Server struct{}\n\nfunc New() *Server { return &Server{} }\n",
      "server/start.go": "package server\n\nfunc (s *Server) Start() {}\n",
      "cmd/main.go": "package main\n\nimport (\n  \"fmt\"\n  srv \"example.com/app/server\"\n)\n\nfunc main() {\n  s := srv.New()\n  s.Start()\n  srv.New().Start()\n  fmt.Println()\n}\n\nfunc typed(s *srv.Server) { s.Start() }\n",
    });
    expect(Object.fromEntries(index.edges.filter((edge) => edge.kind === "imports" && edge.fromFile === "cmd/main.go").map((edge) => [edge.toName, edge.toFile]))).toEqual({ fmt: undefined, "example.com/app/server": "server/server.go" });
    expect(calls(index, "cmd/main.go#main", "New")).toEqual(["server/server.go#New", "server/server.go#New"]);
    expect(calls(index, "cmd/main.go#main", "Start")).toEqual(["server/start.go#Server.Start", "server/start.go#Server.Start"]);
    expect(calls(index, "cmd/main.go#typed", "Start")).toEqual(["server/start.go#Server.Start"]);
    const println = index.outgoing("cmd/main.go#main").find((edge) => edge.toName === "Println");
    expect(println?.evidence).toMatchObject({ resolution: { status: "unresolved", reason: "import-target-unresolved" } });
  });

  it("resolves Rust use paths against the crate root and impl blocks in other files", async () => {
    const index = await build({
      "Cargo.toml": "[package]\nname = 'x'\n",
      "src/lib.rs": "pub mod server;\npub mod net;\n",
      "src/server.rs": "pub struct Server;\nimpl Server { pub fn new() -> Server { Server } }\n",
      "src/net/mod.rs": "pub mod client;\nimpl crate::server::Server { pub fn start(&self) {} }\n",
      "src/net/client.rs": "use crate::server::Server;\nuse super::helper;\nuse std::io;\n\npub fn helper() {}\n\npub fn run(s: &Server) {\n    s.start();\n    Server::new().start();\n    helper();\n    io::stdin();\n}\n",
    });
    expect(Object.fromEntries(index.edges.filter((edge) => edge.kind === "imports" && edge.fromFile === "src/net/client.rs").map((edge) => [edge.toName, edge.toFile]))).toEqual({ "crate::server::Server": "src/server.rs", "super::helper": "src/net/mod.rs", "std::io": undefined });
    expect(calls(index, "src/net/client.rs#run", "start")).toEqual(["src/net/mod.rs#Server.start", "src/net/mod.rs#Server.start"]);
    expect(calls(index, "src/net/client.rs#run", "new")).toEqual(["src/server.rs#Server.new"]);
    const stdin = index.outgoing("src/net/client.rs#run").find((edge) => edge.toName === "stdin");
    expect(stdin?.evidence).toMatchObject({ resolution: { status: "unresolved", reason: "import-target-unresolved" } });
  });
});

describe("Java and C# receivers", () => {
  it("binds Java parameters, locals, fields, this, static class access and imports", async () => {
    const index = await build({
      "src/main/java/a/b/Server.java": "package a.b;\n\npublic class Server {\n  public void start() {}\n  public static Server create() { return new Server(); }\n  public Server self() { return this; }\n}\n",
      "src/main/java/a/App.java": "package a;\n\nimport a.b.Server;\n\npublic class App {\n  private Server field;\n  private static int count;\n  private Server make() { return new Server(); }\n  void run(Server s, Object o) {\n    s.start();\n    Server t = new Server();\n    t.start();\n    var u = make();\n    u.start();\n    this.field.start();\n    field.start();\n    Server.create().start();\n    Server.create();\n    make().self().start();\n    o.start();\n    this.run(s, o);\n    Server w = null;\n    w = other();\n    w.start();\n  }\n}\n",
    });
    expect(index.symbols.get("src/main/java/a/b/Server.java#Server.create")?.memberKind).toBe("static");
    expect(index.symbols.get("src/main/java/a/App.java#App.make")?.returns).toEqual({ kind: "import", source: "a.b.Server", importedName: "Server" });
    expect(calls(index, "src/main/java/a/App.java#App.run", "start")).toEqual([
      "src/main/java/a/b/Server.java#Server.start", "src/main/java/a/b/Server.java#Server.start", "src/main/java/a/b/Server.java#Server.start", "src/main/java/a/b/Server.java#Server.start", "src/main/java/a/b/Server.java#Server.start",
      "src/main/java/a/b/Server.java#Server.start", "src/main/java/a/b/Server.java#Server.start", undefined, undefined,
    ]);
    expect(calls(index, "src/main/java/a/App.java#App.run", "create")).toEqual(["src/main/java/a/b/Server.java#Server.create", "src/main/java/a/b/Server.java#Server.create"]);
    expect(calls(index, "src/main/java/a/App.java#App.run", "run")).toEqual(["src/main/java/a/App.java#App.run"]);
  });

  it("binds C# parameters, locals, fields, properties, this and static class access through unique names", async () => {
    const index = await build({
      "Lib/Server.cs": "namespace Lib {\n  public class Server {\n    public void Start() {}\n    public static Server Create() { return new Server(); }\n  }\n}\n",
      "App/Runner.cs": "using Lib;\n\nnamespace App {\n  public class Runner {\n    private Server field;\n    public Server Prop { get; set; }\n    private static Server Make() { return new Server(); }\n    public void Run(Server s, object o) {\n      s.Start();\n      Server t = new Server();\n      t.Start();\n      var u = Make();\n      u.Start();\n      this.field.Start();\n      field.Start();\n      Prop.Start();\n      Server.Create().Start();\n      o.Start();\n      s = null;\n      s.Start();\n    }\n  }\n}\n",
    });
    expect(index.symbols.get("Lib/Server.cs#Server.Create")?.memberKind).toBe("static");
    expect(calls(index, "App/Runner.cs#Runner.Run", "Start")).toEqual([
      undefined, "Lib/Server.cs#Server.Start", "Lib/Server.cs#Server.Start", "Lib/Server.cs#Server.Start", "Lib/Server.cs#Server.Start", "Lib/Server.cs#Server.Start", "Lib/Server.cs#Server.Start", undefined, undefined,
    ]);
    expect(calls(index, "App/Runner.cs#Runner.Run", "Create")).toEqual(["Lib/Server.cs#Server.Create"]);
  });
});

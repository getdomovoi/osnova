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
      "server.go#Server.Start", "server.go#Server.Start", "server.go#Server.Start", "server.go#Server.Start", "server.go#Server.Start", "server.go#Server.Start", "server.go#Server.Start", undefined, undefined, "server.go#Server.Start",
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
    expect(calls(index, "src/main.rs#run", "start")).toEqual([...Array.from({ length: 8 }, () => "src/server.rs#Server.start"), undefined, "src/server.rs#Server.start"]);
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
      "src/main/java/a/b/Server.java#Server.start", "src/main/java/a/b/Server.java#Server.start", undefined, "src/main/java/a/b/Server.java#Server.start",
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
      "Lib/Server.cs#Server.Start", "Lib/Server.cs#Server.Start", "Lib/Server.cs#Server.Start", "Lib/Server.cs#Server.Start", "Lib/Server.cs#Server.Start", "Lib/Server.cs#Server.Start", "Lib/Server.cs#Server.Start", undefined, "Lib/Server.cs#Server.Start",
    ]);
    expect(calls(index, "App/Runner.cs#Runner.Run", "Create")).toEqual(["Lib/Server.cs#Server.Create"]);
  });
});

describe("typed receiver precision", () => {
  it("sees the binding in force at the call site, keeps a declared type through captured writes, and keeps test packages apart", async () => {
    const index = await build({
      "Cargo.toml": "[package]\nname = 'x'\n",
      "src/main.rs": "struct Other;\nimpl Other { fn start(&self) {} }\nstruct Server;\nimpl Server { fn start(&self) {} }\nfn unknown() -> Other { Other }\nfn shadow() {\n    let x = unknown();\n    x.start();\n    let x: Server = Server;\n    x.start();\n}\ntrait Trait { fn run(&self); fn make() -> Self; }\nimpl Trait for Server { fn run(&self) {} fn make() -> Self { Server } }\nimpl Server { fn own(&self) {} }\nfn use_it(s: &Server) {\n    s.run();\n    s.own();\n    Server::make();\n}\n",
      "go.mod": "module example.com/app\n",
      "pkg/prod.go": "package foo\n\ntype Server struct{}\n\nfunc (*Server) Start() {}\n\ntype Runner interface { Run() }\n\ntype Impl struct{}\n\nfunc (*Impl) Run() {}\n\nfunc closure(s *Server, r Runner) {\n  f := func() { s = nil; s.Start() }\n  f()\n  s.Start()\n  r.Run()\n}\n",
      "pkg/prod_test.go": "package foo_test\n\ntype Server struct{}\n\nfunc (*Server) Start() {}\n",
      "cmd/main.go": "package main\n\nimport \"example.com/app/pkg\"\n\nfunc f(s *pkg.Server) { s.Start() }\n",
    });
    expect(calls(index, "src/main.rs#shadow", "start")).toEqual(["src/main.rs#Other.start", "src/main.rs#Server.start"]);
    expect(index.symbols.has("src/main.rs#Server.Trait.run")).toBe(true);
    expect(calls(index, "src/main.rs#use_it", "run")).toEqual([undefined]);
    expect(calls(index, "src/main.rs#use_it", "own")).toEqual(["src/main.rs#Server.own"]);
    expect(calls(index, "src/main.rs#use_it", "make")).toEqual([undefined]);
    expect(calls(index, "pkg/prod.go#closure", "Start")).toEqual(["pkg/prod.go#Server.Start", "pkg/prod.go#Server.Start"]);
    expect(calls(index, "pkg/prod.go#closure", "Run")).toEqual(["pkg/prod.go#Runner.Run"]);
    expect(index.symbols.get("pkg/prod.go#Runner.Run")?.memberKind).toBe("instance");
    expect(calls(index, "cmd/main.go#f", "Start")).toEqual(["pkg/prod.go#Server.Start"]);
  });

  it("lets a later local shadow a package or type name only from its declaration onward", async () => {
    const index = await build({
      "go.mod": "module example.com/app\n",
      "pkg/server.go": "package pkg\n\nfunc Start() {}\n",
      "main.go": "package main\n\nimport pkg \"example.com/app/pkg\"\n\nfunc f() {\n  pkg.Start()\n  pkg := 1\n  _ = pkg\n}\n",
      "App.java": "class Server { static void start() {} }\nclass App {\n  void f() {\n    Server.start();\n    Server Server = new Server();\n    Server.start();\n  }\n}\n",
    });
    expect(calls(index, "main.go#f", "Start")).toEqual(["pkg/server.go#Start"]);
    expect(calls(index, "App.java#App.f", "start")).toEqual(["App.java#Server.start", undefined]);
  });
});

describe("Go tuple returns", () => {
  it("binds each name of a multi-value declaration to its position in the result list", async () => {
    const index = await build({
      "server.go": "package a\n\ntype Server struct{}\n\nfunc (s *Server) Start() {}\n\ntype Conn struct{}\n\nfunc (c *Conn) Send() {}\n\nfunc dial() (*Server, *Conn, error) { return nil, nil, nil }\n\nfunc named() (srv *Server, err error) { return nil, nil }\n\nfunc pair() (a, b *Conn) { return nil, nil }\n\nfunc use() {\n  s, c, err := dial()\n  s.Start()\n  c.Send()\n  err.Error()\n  n, _ := named()\n  n.Start()\n  x, y := pair()\n  x.Send()\n  y.Send()\n  p, q := dial()\n  p.Start()\n  q.Send()\n}\n",
    });
    expect(index.symbols.get("server.go#dial")?.returnTuple).toEqual([{ kind: "local", name: "Server" }, { kind: "local", name: "Conn" }, { kind: "local", name: "error" }]);
    expect(index.symbols.get("server.go#named")?.returnTuple).toEqual([{ kind: "local", name: "Server" }, { kind: "local", name: "error" }]);
    expect(index.symbols.get("server.go#pair")?.returnTuple).toEqual([{ kind: "local", name: "Conn" }, { kind: "local", name: "Conn" }]);
    expect(calls(index, "server.go#use", "Start")).toEqual(["server.go#Server.Start", "server.go#Server.Start", "server.go#Server.Start"]);
    expect(calls(index, "server.go#use", "Send")).toEqual(["server.go#Conn.Send", "server.go#Conn.Send", "server.go#Conn.Send", "server.go#Conn.Send"]);
    expect(calls(index, "server.go#use", "Error")).toEqual([undefined]);
  });
});

describe("Rust receivers inside closures and unwrap patterns", () => {
  it("sees self from a closure, and binds the name an if let, while let or match arm takes out of an Option", async () => {
    const index = await build({
      "Cargo.toml": "[package]\nname = 'x'\n",
      "src/lib.rs": [
        "pub struct Term(u8);",
        "impl Term {",
        "    pub fn as_byte(&self) -> u8 { self.0 }",
        "    pub fn is_suffix(&self, slice: &[u8]) -> bool { slice.last().map_or(false, |&b| b == self.as_byte()) }",
        "}",
        "pub struct Sink { pub(crate) term: Term }",
        "impl Sink {",
        "    pub fn byte(&self) -> u8 { self.term.as_byte() }",
        "    pub fn find(&self) -> Option<Term> { None }",
        "    pub fn each(&self) -> u8 { let mut n = 0; while let Some(t) = self.find() { n += t.as_byte(); } n }",
        "}",
        "pub fn maybe(t: Option<Term>) -> u8 { if let Some(term) = t { term.as_byte() } else { 0 } }",
        "pub fn matched(t: Option<&Term>) -> u8 { match t { Some(term) => term.as_byte(), None => 0 } }",
        "pub fn result(r: Result<Term, String>) -> u8 { if let Ok(term) = r { term.as_byte() } else { 0 } }",
        "pub fn wrapped(s: &Sink) -> u8 { if let Some(term) = s.find() { term.as_byte() } else { 0 } }",
        "pub fn other(t: Option<u8>) -> u8 { if let Some(term) = t { term.as_byte() } else { 0 } }",
        "",
      ].join("\n"),
    });
    expect(calls(index, "src/lib.rs#Term.is_suffix", "as_byte")).toEqual(["src/lib.rs#Term.as_byte"]);
    expect(calls(index, "src/lib.rs#Sink.byte", "as_byte")).toEqual(["src/lib.rs#Term.as_byte"]);
    expect(calls(index, "src/lib.rs#Sink.each", "as_byte")).toEqual(["src/lib.rs#Term.as_byte"]);
    for (const fn of ["maybe", "matched", "result", "wrapped"]) expect(calls(index, `src/lib.rs#${fn}`, "as_byte"), fn).toEqual(["src/lib.rs#Term.as_byte"]);
    expect(calls(index, "src/lib.rs#other", "as_byte")).toEqual([undefined]);
  });
});

describe("Rust workspace crates and inline modules", () => {
  it("resolves a use of another workspace crate by package name through its pub use re-export, a brace-rooted use list, and keeps a test module's use super out of the file scope", async () => {
    const index = await build({
      "Cargo.toml": "[workspace]\nmembers = [\"crates/matcher\", \"crates/searcher\"]\n",
      "crates/matcher/Cargo.toml": "[package]\nname = \"grep-matcher\"\nversion = \"0.1.0\"\n",
      "crates/matcher/src/lib.rs": "mod term;\npub use crate::term::LineTerminator;\n",
      "crates/matcher/src/term.rs": "pub struct LineTerminator(u8);\nimpl LineTerminator { pub fn as_byte(&self) -> u8 { self.0 } }\n",
      "crates/searcher/Cargo.toml": "[package]\nname = \"grep-searcher\"\nversion = \"0.1.0\"\n",
      "crates/searcher/src/lib.rs": [
        "use {",
        "    grep_matcher::LineTerminator,",
        "    std::io,",
        "};",
        "pub struct SinkMatch { pub(crate) term: LineTerminator }",
        "impl SinkMatch { pub fn byte(&self) -> u8 { self.term.as_byte() } }",
        "pub fn strip(term: LineTerminator) -> u8 { term.as_byte() }",
        "#[cfg(test)]",
        "mod tests {",
        "    use super::{LineTerminator, SinkMatch};",
        "    fn check(m: &SinkMatch, t: LineTerminator) -> u8 { m.byte() + t.as_byte() }",
        "}",
        "",
      ].join("\n"),
    });
    expect(calls(index, "crates/searcher/src/lib.rs#strip", "as_byte")).toEqual(["crates/matcher/src/term.rs#LineTerminator.as_byte"]);
    expect(calls(index, "crates/searcher/src/lib.rs#SinkMatch.byte", "as_byte")).toEqual(["crates/matcher/src/term.rs#LineTerminator.as_byte"]);
    expect(calls(index, "crates/searcher/src/lib.rs#check", "byte")).toEqual(["crates/searcher/src/lib.rs#SinkMatch.byte"]);
    expect(calls(index, "crates/searcher/src/lib.rs#check", "as_byte")).toEqual(["crates/matcher/src/term.rs#LineTerminator.as_byte"]);
  });
});

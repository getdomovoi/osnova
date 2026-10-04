import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-rust-plain-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
});

afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

async function build(files: Record<string, string>) {
  await fs.writeFile(path.join(workspace, "Cargo.toml"), '[package]\nname = "app"\nversion = "0.1.0"\n');
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await fs.writeFile(path.join(workspace, file), text);
  }
  return buildIndex(workspace, { cacheDir });
}

const callAt = (index: Awaited<ReturnType<typeof build>>, file: string, line: number, name: string) =>
  index.edges.find((edge) => edge.kind === "calls" && edge.fromFile === file && edge.line === line && edge.toName === name);

describe("a plain Rust call and an inline module", () => {
  const files = {
    "src/ban.rs": [
      "pub fn check(hay: &str) -> bool { hay.is_empty() }",
      "",
      "pub fn run(hay: &str) -> bool {",
      "    check(hay)",
      "}",
      "",
      "#[cfg(test)]",
      "mod tests {",
      "    fn check(hay: &str) -> bool { !super::check(hay) }",
      "",
      "    #[test]",
      "    fn inner() {",
      "        let _ = check(\"x\");",
      "    }",
      "}",
      "",
    ].join("\n"),
    "src/config.rs": [
      "use crate::ban;",
      "",
      "pub fn load(hay: &str) -> bool {",
      "    ban::check(hay)",
      "}",
      "",
    ].join("\n"),
    "src/lib.rs": "pub mod ban;\npub mod config;\n",
  };

  it("keeps the module's function and the file's function as two records", async () => {
    const index = await build(files);
    const names = [...index.symbols.values()].filter((symbol) => symbol.file === "src/ban.rs" && symbol.name === "check").map((symbol) => symbol.qualifiedName).sort();
    expect(names).toEqual(["src/ban.rs#check", "src/ban.rs#tests.check"]);
    expect(index.symbols.get("src/ban.rs#tests")).toMatchObject({ kind: "module" });
  });

  it("names the file's function from the file's own scope", async () => {
    const index = await build(files);
    expect(callAt(index, "src/ban.rs", 4, "check")).toMatchObject({ toSymbol: "src/ban.rs#check", evidence: { resolution: { status: "resolved" } } });
  });

  it("names the module's function from inside the module", async () => {
    const index = await build(files);
    expect(callAt(index, "src/ban.rs", 13, "check")).toMatchObject({ toSymbol: "src/ban.rs#tests.check", evidence: { resolution: { status: "resolved" } } });
  });

  it("names the file's function through super:: from inside the module", async () => {
    const index = await build(files);
    expect(callAt(index, "src/ban.rs", 9, "check")).toMatchObject({ toSymbol: "src/ban.rs#check", evidence: { resolution: { status: "resolved" } } });
  });

  it("names the file's function through a module path from another file", async () => {
    const index = await build(files);
    expect(callAt(index, "src/config.rs", 4, "check")).toMatchObject({ toSymbol: "src/ban.rs#check", evidence: { resolution: { status: "resolved" } } });
  });
});

describe("a plain Rust call and cfg-gated declarations", () => {
  it("refuses a name the file declares more than once in one scope", async () => {
    const index = await build({
      "src/lib.rs": [
        "#[cfg(unix)]",
        "fn device_num(path: &str) -> u64 { 1 }",
        "",
        "#[cfg(not(unix))]",
        "fn device_num(path: &str) -> u64 { 2 }",
        "",
        "pub fn run(path: &str) -> u64 {",
        "    device_num(path)",
        "}",
        "",
      ].join("\n"),
    });
    const edge = callAt(index, "src/lib.rs", 8, "device_num");
    expect(edge?.toSymbol).toBeUndefined();
    expect(edge).toMatchObject({ evidence: { source: "syntax" } });
    expect(edge).not.toMatchObject({ evidence: { resolution: { status: "resolved" } } });
  });
});

describe("a Rust path call and cfg-gated methods", () => {
  it("refuses a method an impl declares more than once under cfg attributes", async () => {
    const index = await build({
      "src/lib.rs": [
        "pub struct Entry;",
        "impl Entry {",
        "    #[cfg(unix)]",
        "    fn from_path(p: &str) -> Entry { Entry }",
        "    #[cfg(not(unix))]",
        "    fn from_path(p: &str) -> Entry { Entry }",
        "}",
        "pub fn make(p: &str) -> Entry {",
        "    Entry::from_path(p)",
        "}",
        "",
      ].join("\n"),
    });
    const edge = callAt(index, "src/lib.rs", 9, "from_path");
    expect(edge?.toSymbol).toBeUndefined();
    expect(edge).toMatchObject({ evidence: { resolution: { status: "unresolved", reason: "shadowed-declaration" } } });
  });
});

describe("a plain Rust call and a local binding", () => {
  const files = {
    "src/other.rs": "pub fn add(x: u32) -> u32 { x + 1 }\npub fn run(x: u32) -> u32 { x }\n",
    "src/lib.rs": [
      "pub mod other;",
      "",
      "pub fn closures(pats: Vec<u32>) -> u32 {",
      "    let mut total = 0;",
      "    let mut add = |pat: u32| total += pat;",
      "    for pat in pats { add(pat); }",
      "    total",
      "}",
      "",
      "pub fn param(run: fn(u32) -> u32) -> u32 {",
      "    run(3)",
      "}",
      "",
      "pub fn pattern(found: Option<fn(u32) -> u32>) -> u32 {",
      "    if let Some(add) = found { add(1) } else { 0 }",
      "}",
      "",
      "pub fn later(x: u32) -> u32 {",
      "    let y = other::add(x);",
      "    let add = |v: u32| v;",
      "    add(y)",
      "}",
      "",
    ].join("\n"),
  };

  it("refuses a call to a closure bound by let", async () => {
    const index = await build(files);
    expect(callAt(index, "src/lib.rs", 6, "add")).toMatchObject({ evidence: { resolution: { status: "unresolved" } } });
    expect(callAt(index, "src/lib.rs", 6, "add")?.toSymbol).toBeUndefined();
  });

  it("refuses a call to a function-typed parameter", async () => {
    const index = await build(files);
    expect(callAt(index, "src/lib.rs", 11, "run")?.toSymbol).toBeUndefined();
  });

  it("refuses a call to an if-let pattern binding", async () => {
    const index = await build(files);
    expect(callAt(index, "src/lib.rs", 15, "add")?.toSymbol).toBeUndefined();
  });

  it("refuses a call to a let binding declared after another call of the name", async () => {
    const index = await build(files);
    expect(callAt(index, "src/lib.rs", 21, "add")?.toSymbol).toBeUndefined();
    expect(callAt(index, "src/lib.rs", 19, "add")).toMatchObject({ toSymbol: "src/other.rs#add" });
  });
});

describe("a plain Rust call and a pattern's own value", () => {
  it("names the function an if-let calls in its own value, under a binding of the same name", async () => {
    const index = await build({
      "src/lib.rs": [
        "fn hostname() -> Option<String> { None }",
        "",
        "pub fn run() {",
        "    if let Some(hostname) = hostname() {",
        "        let _ = hostname;",
        "    }",
        "    for hostname in hostname() { let _ = hostname; }",
        "}",
        "",
      ].join("\n"),
    });
    expect(callAt(index, "src/lib.rs", 4, "hostname")).toMatchObject({ toSymbol: "src/lib.rs#hostname" });
    expect(callAt(index, "src/lib.rs", 7, "hostname")).toMatchObject({ toSymbol: "src/lib.rs#hostname" });
  });
});

describe("a plain Rust call and module declarations", () => {
  it("names a function re-exported next to a module file of the same name", async () => {
    const index = await build({
      "src/lib.rs": "mod hostname;\npub use crate::hostname::hostname;\n",
      "src/hostname.rs": "pub fn hostname() -> String { String::new() }\n",
      "src/main.rs": "use app::hostname;\n\nfn main() {\n    let _ = hostname();\n}\n",
    });
    expect([...index.symbols.values()].filter((symbol) => symbol.file === "src/lib.rs").map((symbol) => symbol.qualifiedName)).toEqual([]);
    expect(callAt(index, "src/main.rs", 4, "hostname")).toMatchObject({ toSymbol: "src/hostname.rs#hostname" });
  });
});

describe("a plain Rust call and a use of a name from outside the workspace", () => {
  it("treats a name imported by a block-level use from std as external", async () => {
    const index = await build({
      "src/walk.rs": "pub fn symlink(src: &str, dst: &str) {}\n",
      "src/lib.rs": [
        "pub mod walk;",
        "",
        "pub fn link(src: &str, dst: &str) {",
        "    use std::os::unix::fs::symlink;",
        "    symlink(src, dst).unwrap();",
        "}",
        "",
      ].join("\n"),
    });
    const edge = callAt(index, "src/lib.rs", 5, "symlink");
    expect(edge?.toSymbol).toBeUndefined();
    expect(edge).toMatchObject({ evidence: { resolution: { status: "unresolved" } } });
  });

  it("treats a name imported by a file-level use from std as external", async () => {
    const index = await build({
      "src/walk.rs": "pub fn symlink(src: &str, dst: &str) {}\n",
      "src/lib.rs": [
        "use std::os::unix::fs::symlink;",
        "pub mod walk;",
        "",
        "pub fn link(src: &str, dst: &str) {",
        "    symlink(src, dst).unwrap();",
        "}",
        "",
      ].join("\n"),
    });
    expect(callAt(index, "src/lib.rs", 5, "symlink")?.toSymbol).toBeUndefined();
  });

  it("still names a function imported by use from a workspace file", async () => {
    const index = await build({
      "src/walk.rs": "pub fn symlink(src: &str, dst: &str) {}\n",
      "src/lib.rs": [
        "pub mod walk;",
        "use crate::walk::symlink;",
        "",
        "pub fn link(src: &str, dst: &str) {",
        "    symlink(src, dst);",
        "}",
        "",
      ].join("\n"),
    });
    expect(callAt(index, "src/lib.rs", 5, "symlink")).toMatchObject({ toSymbol: "src/walk.rs#symlink" });
  });
});

describe("a plain Rust call and a method of an impl for a foreign type", () => {
  it("never names a trait impl method for a type outside the index", async () => {
    const index = await build({
      "src/matcher.rs": [
        "pub struct NoError;",
        "pub trait Matcher { type Error; }",
        "impl<'a, M: Matcher> Matcher for &'a M { type Error = M::Error; }",
        "impl From<NoError> for std::io::Error {",
        "    fn from(_: NoError) -> std::io::Error { unreachable!() }",
        "}",
        "",
      ].join("\n"),
      "src/sink.rs": [
        "pub fn wrap(e: Box<dyn std::error::Error>) -> Box<dyn std::error::Error> {",
        "    Box::<dyn std::error::Error>::from(e)",
        "}",
        "",
      ].join("\n"),
      "src/lib.rs": "pub mod matcher;\npub mod sink;\n",
    });
    expect(callAt(index, "src/sink.rs", 2, "from")?.toSymbol).toBeUndefined();
  });
});

describe("Rust module scope, from rustc reproductions", () => {
  const target = async (files: Record<string, string>, file: string, line: number, name: string) => {
    const index = await build(files);
    return callAt(index, file, line, name);
  };

  it("names the function a child module imports by crate path, not the file root's", async () => {
    const edge = await target({ "src/main.rs": [
      "fn f() -> &'static str { \"ROOT\" }",
      "mod inner { pub fn f() -> &'static str { \"INNER\" } }",
      "mod m {",
      "    use crate::inner::f;",
      "    pub fn run() -> &'static str { f() }",
      "}",
      "fn main() { println!(\"{}\", m::run()); }",
      "",
    ].join("\n") }, "src/main.rs", 5, "f");
    expect(edge).toMatchObject({ toSymbol: "src/main.rs#inner.f" });
  });

  it("names the function a child module imports by self path or glob", async () => {
    for (const use of ["use super::inner::f;", "use super::inner::*;"]) {
      const edge = await target({ "src/main.rs": [
        "fn f() -> &'static str { \"ROOT\" }",
        "mod inner { pub fn f() -> &'static str { \"INNER\" } }",
        "mod m {",
        `    ${use}`,
        "    pub fn run() -> &'static str { f() }",
        "}",
        "fn main() { println!(\"{}\", m::run()); }",
        "",
      ].join("\n") }, "src/main.rs", 5, "f");
      expect(edge?.toSymbol).toBe("src/main.rs#inner.f");
    }
  });

  it("never names a file-root function from a child module that does not import it", async () => {
    const edge = await target({ "src/main.rs": [
      "fn f() -> &'static str { \"ROOT\" }",
      "macro_rules! make { () => { pub fn f() -> &'static str { \"MACRO\" } } }",
      "mod m {",
      "    make!();",
      "    pub fn run() -> &'static str { f() }",
      "}",
      "fn main() { println!(\"{}\", m::run()); }",
      "",
    ].join("\n") }, "src/main.rs", 5, "f");
    expect(edge?.toSymbol).toBeUndefined();
  });

  it("still names the parent's function through use super::*", async () => {
    const edge = await target({ "src/main.rs": [
      "fn f() -> &'static str { \"ROOT\" }",
      "#[cfg(test)]",
      "mod tests {",
      "    use super::*;",
      "    fn run() -> &'static str { f() }",
      "}",
      "fn main() {}",
      "",
    ].join("\n") }, "src/main.rs", 5, "f");
    expect(edge?.toSymbol).toBe("src/main.rs#f");
  });

  it("follows a re-export through an inline module", async () => {
    const edge = await target({ "src/main.rs": [
      "fn f() -> &'static str { \"ROOT\" }",
      "mod inner { pub fn f() -> &'static str { \"INNER\" } }",
      "pub(crate) use crate::inner::f as g;",
      "fn main() { let _value = crate::g(); }",
      "",
    ].join("\n") }, "src/main.rs", 4, "g");
    expect(edge?.toSymbol).toBe("src/main.rs#inner.f");
  });

  it("blocks a call to a match binding inside its guard", async () => {
    const edge = await target({ "src/main.rs": [
      "fn f() -> &'static str { \"ROOT\" }",
      "fn main() {",
      "    match Some(|| \"LOCAL\") {",
      "        Some(f) if f() == \"LOCAL\" => println!(\"LOCAL\"),",
      "        _ => println!(\"ROOT\"),",
      "    }",
      "}",
      "",
    ].join("\n") }, "src/main.rs", 4, "f");
    expect(edge?.toSymbol).toBeUndefined();
  });

  it("blocks a call to a struct-pattern shorthand binding", async () => {
    const edge = await target({ "src/main.rs": [
      "fn f() -> &'static str { \"ROOT\" }",
      "struct Holder { f: fn() -> &'static str }",
      "fn main() {",
      "    let Holder { f } = Holder { f: || \"LOCAL\" };",
      "    let _value = f();",
      "}",
      "",
    ].join("\n") }, "src/main.rs", 5, "f");
    expect(edge?.toSymbol).toBeUndefined();
  });

  it("names the inline module's function over a stray file of the module's name", async () => {
    const edge = await target({
      "src/main.rs": [
        "mod m {",
        "    mod inner { pub fn f() -> &'static str { \"INLINE\" } }",
        "    pub fn run() -> &'static str { self::inner::f() }",
        "}",
        "fn main() { println!(\"{}\", m::run()); }",
        "",
      ].join("\n"),
      "src/m.rs": "pub mod inner { pub fn f() -> &'static str { \"FILE\" } }\n",
    }, "src/main.rs", 3, "f");
    expect(edge?.toSymbol).toBe("src/main.rs#m.inner.f");
  });
});

describe("Rust scope, round-2 rustc reproductions", () => {
  const target = async (files: Record<string, string>, file: string, line: number, name: string) => callAt(await build(files), file, line, name);

  it("never names another item when a use names a declaration the index cannot follow", async () => {
    const reexport = await target({ "src/main.rs": [
      "fn f() -> &'static str { \"ROOT\" }",
      "mod inner { pub fn f() -> &'static str { \"INNER\" } }",
      "mod facade { pub(crate) use crate::inner::f; }",
      "fn run() -> &'static str {",
      "    use crate::facade::f;",
      "    f()",
      "}",
      "fn main() { let _ = run(); }",
      "",
    ].join("\n") }, "src/main.rs", 6, "f");
    expect(reexport?.toSymbol).not.toBe("src/main.rs#f");
    const macro = await target({ "src/main.rs": [
      "fn f() -> &'static str { \"ROOT\" }",
      "mod provider {",
      "    macro_rules! define { () => { pub fn g() -> &'static str { \"MACRO\" } } }",
      "    define!();",
      "}",
      "fn run() -> &'static str {",
      "    use crate::provider::g as f;",
      "    f()",
      "}",
      "fn main() { let _ = run(); }",
      "",
    ].join("\n") }, "src/main.rs", 8, "f");
    expect(macro?.toSymbol).toBeUndefined();
  });

  it("lets a nearer block's glob win over an outer item or use", async () => {
    const item = await target({ "src/main.rs": [
      "mod other { pub fn f() -> &'static str { \"OTHER\" } }",
      "mod m {",
      "    fn f() -> &'static str { \"ROOT\" }",
      "    pub fn run() -> &'static str {",
      "        use crate::other::*;",
      "        f()",
      "    }",
      "}",
      "fn main() { let _ = m::run(); }",
      "",
    ].join("\n") }, "src/main.rs", 6, "f");
    expect(item?.toSymbol).toBe("src/main.rs#other.f");
    const root = await target({ "src/main.rs": [
      "fn f() -> &'static str { \"ROOT\" }",
      "mod other { pub fn f() -> &'static str { \"OTHER\" } }",
      "fn run() -> &'static str {",
      "    use crate::other::*;",
      "    f()",
      "}",
      "fn main() { let _ = run(); }",
      "",
    ].join("\n") }, "src/main.rs", 5, "f");
    expect(root?.toSymbol).toBe("src/main.rs#other.f");
    const variant = await target({ "src/main.rs": [
      "fn F(x: u32) -> u32 { x }",
      "enum Kind { F(u32) }",
      "fn run() -> Kind {",
      "    use Kind::*;",
      "    F(1)",
      "}",
      "fn main() { let _ = run(); }",
      "",
    ].join("\n") }, "src/main.rs", 5, "F");
    expect(variant?.toSymbol).not.toBe("src/main.rs#F");
  });

  it("keeps an outer function when a nearer enum glob does not provide its name", async () => {
    const edge = await target({ "src/main.rs": [
      "enum Mode { Fast, Slow(u32) }",
      "fn search_path(x: u32) -> u32 { x }",
      "fn run(m: Mode) -> u32 {",
      "    use self::Mode::*;",
      "    match m { Fast => search_path(1), Slow(n) => search_path(n) }",
      "}",
      "fn main() { let _ = run(Mode::Fast); }",
      "",
    ].join("\n") }, "src/main.rs", 5, "search_path");
    expect(edge?.toSymbol).toBe("src/main.rs#search_path");
  });

  it("never follows a module declared with a path attribute to its conventional file", async () => {
    const edge = await target({
      "src/main.rs": "#[path = \"chosen.rs\"] mod m;\nfn run() -> &'static str {\n    crate::m::f()\n}\nfn main() { let _ = run(); }\n",
      "src/chosen.rs": "pub fn f() -> &'static str { \"CHOSEN\" }\n",
      "src/m.rs": "pub fn f() -> &'static str { \"STRAY\" }\n",
    }, "src/main.rs", 3, "f");
    expect(edge?.toSymbol).not.toBe("src/m.rs#f");
  });

  it("never names a function nested in another function from outside it", async () => {
    const edge = await target({
      "src/main.rs": "include!(\"included.rs\");\nfn helper() { fn f() -> &'static str { \"NESTED\" } let _ = f(); }\nfn run() -> &'static str {\n    f()\n}\nfn main() { let _ = run(); }\n",
      "src/included.rs": "fn f() -> &'static str { \"INCLUDED\" }\n",
    }, "src/main.rs", 4, "f");
    expect(edge?.toSymbol).not.toBe("src/main.rs#helper.f");
    const inside = await target({ "src/main.rs": "fn helper() { fn f() -> u32 { 1 } let _ = f(); }\nfn main() { helper(); }\n" }, "src/main.rs", 1, "f");
    expect(inside?.toSymbol).toBe("src/main.rs#helper.f");
  });

  it("reads crate:: from an integration test file as that file's own crate", async () => {
    const edge = await target({
      "src/lib.rs": "pub fn lib_fn() {}\n",
      "tests/util.rs": "pub fn helper() -> u32 { 1 }\n",
      "tests/run.rs": "mod util;\nuse crate::util::helper;\n#[test]\nfn t() {\n    let _ = helper();\n}\n",
    }, "tests/run.rs", 5, "helper");
    expect(edge?.toSymbol).toBe("tests/util.rs#helper");
  });
});

describe("Rust scope, round-3 rustc reproductions", () => {
  const target = async (files: Record<string, string>, file: string, line: number, name: string) => callAt(await build(files), file, line, name);
  const notRoot = async (files: Record<string, string>, file: string, line: number, name: string, wrong: string) => {
    const edge = await target(files, file, line, name);
    expect(edge?.toSymbol).not.toBe(wrong);
    return edge;
  };

  it("never discards a glob by naming convention or another scope's enum", async () => {
    await notRoot({
      "src/main.rs": "mod other;\nfn f() -> &'static str { \"ROOT\" }\nfn run() -> u32 {\n    use crate::other::Kind::*;\n    let _x = f();\n    0\n}\nfn main() { let _ = run(); }\n",
      "src/other.rs": "#[allow(non_camel_case_types)] pub enum Kind { f() }\n",
    }, "src/main.rs", 5, "f", "src/main.rs#f");
    await notRoot({ "src/main.rs": "#[allow(non_snake_case)] mod Upper { pub fn f() -> u32 { 1 } }\nfn f() -> u32 { 0 }\nfn run() -> u32 {\n    use crate::Upper::*;\n    f()\n}\nfn main() { let _ = run(); }\n" }, "src/main.rs", 5, "f", "src/main.rs#f");
    await notRoot({ "src/main.rs": "mod other { #[allow(non_camel_case_types)] pub enum Kind { f() } }\nmod unused { pub enum Kind { G } }\nfn f() -> u32 { 0 }\nfn run() {\n    use crate::other::Kind::*;\n    let _x = f();\n}\nfn main() { run(); }\n" }, "src/main.rs", 6, "f", "src/main.rs#f");
  });

  it("reads a grouped glob", async () => {
    await notRoot({ "src/main.rs": "enum Kind { F(), Root }\n#[allow(non_snake_case)] fn F() -> Kind { Kind::Root }\nfn run() {\n    use Kind::{self, *};\n    let _x = F();\n}\nfn main() { run(); }\n" }, "src/main.rs", 5, "F", "src/main.rs#F");
  });

  it("never follows a module whose path a cfg_attr or a far attribute sets", async () => {
    await notRoot({
      "src/main.rs": "#[cfg_attr(all(), path = \"chosen.rs\")] mod m;\nfn run() -> &'static str {\n    crate::m::f()\n}\nfn main() { let _ = run(); }\n",
      "src/chosen.rs": "pub fn f() -> &'static str { \"CHOSEN\" }\n",
      "src/m.rs": "pub fn f() -> &'static str { \"STRAY\" }\n",
    }, "src/main.rs", 3, "f", "src/m.rs#f");
    await notRoot({
      "src/main.rs": `#[path = "chosen.rs"]\n#[doc = "${"x".repeat(240)}"]\npub(crate) mod m;\nfn run() -> &'static str {\n    crate::m::f()\n}\nfn main() { let _ = run(); }\n`,
      "src/chosen.rs": "pub fn f() -> &'static str { \"CHOSEN\" }\n",
      "src/m.rs": "pub fn f() -> &'static str { \"STRAY\" }\n",
    }, "src/main.rs", 5, "f", "src/m.rs#f");
    await notRoot({
      "src/lib.rs": "pub fn unrelated() {}\n",
      "tests/basic.rs": "#[path = \"chosen.rs\"] mod m;\nfn run() -> &'static str {\n    crate::m::f()\n}\n",
      "tests/chosen.rs": "pub fn f() -> &'static str { \"CHOSEN\" }\n",
      "tests/m.rs": "pub fn f() -> &'static str { \"STRAY\" }\n",
    }, "tests/basic.rs", 3, "f", "tests/m.rs#f");
  });

  it("never reads crate:: from an integration test's child module as the package library", async () => {
    await notRoot({
      "src/lib.rs": "pub fn f() -> &'static str { \"LIB\" }\n",
      "tests/basic.rs": "mod common;\nfn f() -> &'static str { \"TEST\" }\nfn run() -> &'static str { common::run() }\n",
      "tests/common/mod.rs": "pub fn run() -> &'static str {\n    crate::f()\n}\n",
    }, "tests/common/mod.rs", 2, "f", "src/lib.rs#f");
  });

  it("reads crate:: from a nested crate root as that root", async () => {
    const edge = await target({
      "src/lib.rs": "pub fn f() -> &'static str { \"OUTER\" }\n",
      "inner/src/main.rs": "fn f() -> &'static str { \"NESTED\" }\nfn run() -> &'static str {\n    crate::f()\n}\nfn main() { let _ = run(); }\n",
    }, "inner/src/main.rs", 3, "f");
    expect(edge?.toSymbol).not.toBe("src/lib.rs#f");
  });

  it("never names a block's function from a sibling block", async () => {
    await notRoot({ "src/main.rs": "macro_rules! define { () => { fn f() -> &'static str { \"ROOT\" } } }\ndefine!();\nfn run() -> &'static str {\n    { fn f() -> &'static str { \"LOCAL\" } let _ = f(); }\n    f()\n}\nfn main() { let _ = run(); }\n" }, "src/main.rs", 5, "f", "src/main.rs#run.f");
    const inside = await target({ "src/main.rs": "fn run() -> &'static str {\n    { fn f() -> &'static str { \"LOCAL\" } let _x = f(); }\n    \"\"\n}\nfn main() { let _ = run(); }\n" }, "src/main.rs", 2, "f");
    expect(inside?.toSymbol).toBe("src/main.rs#run.f");
  });
});

describe("Rust module files, round-4 rustc reproductions", () => {
  const target = async (files: Record<string, string>, file: string, line: number, name: string) => callAt(await build(files), file, line, name);

  it("never walks past a module whose path an attribute sets, or into a file child of an inline module", async () => {
    const opaque = await target({
      "src/main.rs": "#[path = \"chosen.rs\"] mod m;\nfn run() -> &'static str {\n    crate::m::child::f()\n}\nfn main() { let _ = run(); }\n",
      "src/chosen.rs": "pub mod child;\n",
      "src/m/child.rs": "pub fn f() -> &'static str { \"STRAY\" }\n",
      "src/child.rs": "pub fn f() -> &'static str { \"CHOSEN\" }\n",
    }, "src/main.rs", 3, "f");
    expect(opaque?.toSymbol).not.toBe("src/m/child.rs#f");
    const inline = await target({
      "src/main.rs": "#[path = \"custom\"] mod m { pub mod child; }\nfn run() -> &'static str {\n    crate::m::child::f()\n}\nfn main() { let _ = run(); }\n",
      "src/custom/child.rs": "pub fn f() -> &'static str { \"CHOSEN\" }\n",
      "src/m/child.rs": "pub fn f() -> &'static str { \"STRAY\" }\n",
    }, "src/main.rs", 3, "f");
    expect(inline?.toSymbol).not.toBe("src/m/child.rs#f");
  });

  it("takes a Cargo target path as the crate root over a stray conventional root", async () => {
    for (const section of ["[lib]", "[[bin]]\nname = \"chosen\""]) {
      const edge = await target({
        "Cargo.toml": `[package]\nname = "app"\nversion = "0.1.0"\n${section}\npath = "src/chosen.rs"\n`,
        "src/chosen.rs": "fn f() -> &'static str { \"CUSTOM\" }\nfn run() -> &'static str {\n    crate::f()\n}\n",
        "src/lib.rs": "pub fn f() -> &'static str { \"STRAY\" }\n",
      }, "src/chosen.rs", 3, "f");
      expect(edge?.toSymbol).not.toBe("src/lib.rs#f");
    }
  });

  it("reads self:: from a test or single-file binary root beside the file", async () => {
    for (const root of ["tests/basic.rs", "src/bin/tool.rs"]) {
      const dir = root.slice(0, root.lastIndexOf("/"));
      const stem = root.slice(root.lastIndexOf("/") + 1, -3);
      const edge = await target({
        "src/lib.rs": "pub fn lib() {}\n",
        [root]: "mod child;\nfn run() -> &'static str {\n    self::child::f()\n}\n",
        [`${dir}/child.rs`]: "pub fn f() -> &'static str { \"CHILD\" }\n",
        [`${dir}/${stem}/child.rs`]: "pub fn f() -> &'static str { \"STRAY\" }\n",
      }, root, 3, "f");
      expect(edge?.toSymbol).toBe(`${dir}/child.rs#f`);
    }
  });

  it("reads crate:: from a test module declared by the test crate's root as that root", async () => {
    const edge = await target({
      "src/lib.rs": "pub fn f() {}\n",
      "tests/tests.rs": "mod test_matcher;\nmod util;\n",
      "tests/util.rs": "pub fn helper() -> u32 { 1 }\n",
      "tests/test_matcher.rs": "use crate::util::helper;\nfn t() {\n    let _ = helper();\n}\n",
    }, "tests/test_matcher.rs", 3, "helper");
    expect(edge?.toSymbol).toBe("tests/util.rs#helper");
  });

  it("never follows a module alias to a stray file of the alias's name", async () => {
    const edge = await target({
      "src/main.rs": "pub mod actual { pub fn f() -> &'static str { \"ACTUAL\" } }\npub use actual as alias;\nfn run() -> &'static str {\n    crate::alias::f()\n}\nfn main() { let _ = run(); }\n",
      "src/alias.rs": "pub fn f() -> &'static str { \"STRAY\" }\n",
    }, "src/main.rs", 4, "f");
    expect(edge?.toSymbol).not.toBe("src/alias.rs#f");
  });
  // Round 5: a declaration the text scan misread, or one it could see but not follow, never proves a module
  // file or a crate root. Each case is a rustc-valid program from the review; the stray target is wrong.
  const stray = "pub fn f() -> &'static str { \"STRAY\" }\n";
  const aliasRest = "pub mod actual { pub fn f() -> &'static str { \"ACTUAL\" } }\npub use actual as alias;\nfn run() -> &'static str {\n    crate::alias::f()\n}\nfn main() { let _ = run(); }\n";
  it.each([
    ["a nested block comment", "/* outer /* inner */ mod alias; */\n"],
    ["a macro body in parentheses", "macro_rules! unused ( () => ( mod alias; ); );\n"],
    ["a macro body in brackets", "macro_rules! unused [ () => [ mod alias; ]; ];\n"],
    ["a cfg-disabled declaration", "#[cfg(any())] mod alias;\n"],
  ])("never follows %s to a stray file of the alias's name", async (_label, prefix) => {
    const edge = await target({ "src/main.rs": prefix + aliasRest, "src/alias.rs": stray }, "src/main.rs", 5, "f");
    expect(edge).toBeDefined();
    expect(edge?.toSymbol).not.toBe("src/alias.rs#f");
  });

  // Round 6.
  it("reads crate:: in a file child of an inline module named like a binary directory as its parent crate's", async () => {
    const edge = await target({
      "Cargo.toml": "[package]\nname=\"app\"\nversion=\"0.1.0\"\nedition=\"2024\"\nautobins=false\n",
      "src/main.rs": "fn f() -> &'static str { \"ROOT\" }\nmod bin { pub mod tool; }\nfn run() -> &'static str { bin::tool::run() }\nfn main() { let _ = run(); }\n",
      "src/bin/tool.rs": "fn f() -> &'static str { \"LOCAL\" }\npub fn run() -> &'static str {\n    crate::f()\n}\n",
    }, "src/bin/tool.rs", 3, "f");
    expect(edge?.toSymbol).not.toBe("src/bin/tool.rs#f");
    if (edge?.toSymbol !== undefined) expect(edge.toSymbol).toBe("src/main.rs#f");
  });

  it("never reads self:: from a file whose rootness an unreadable path leaves unproven", async () => {
    const edge = await target({
      "src/main.rs": "#[path=\"chosen\\x2ers\"] mod extra;\nmod child;\nfn run() -> &'static str {\n    self::child::f()\n}\nfn main() { let _ = run(); }\n",
      "src/chosen.rs": "pub fn unused() {}\n",
      "src/child.rs": "pub fn f() -> &'static str { \"CHILD\" }\n",
      "src/main/child.rs": "pub fn f() -> &'static str { \"STRAY\" }\n",
    }, "src/main.rs", 4, "f");
    expect(edge).toBeDefined();
    expect(edge?.toSymbol).not.toBe("src/main/child.rs#f");
  });

  it.each([
    ["a unit struct of the name", "#[cfg(any())] mod alias;\n#[allow(non_camel_case_types)] struct alias;\nimpl alias { fn f() -> &'static str { \"METHOD\" } }\n", {}],
    ["a glob that may bring the name in", "#[cfg(any())] mod alias;\nmod actual;\nuse actual::*;\n", { "src/actual.rs": "pub mod alias { pub fn f() -> &'static str { \"ACTUAL\" } }\n" }],
  ] as const)("never follows a cfg-gated module next to %s", async (_label, prefix, extra) => {
    const edge = await target({ "src/main.rs": prefix + "fn run() -> &'static str {\n    crate::alias::f()\n}\nfn main() { let _ = run(); }\n", "src/alias.rs": "pub fn f() -> &'static str { \"STRAY\" }\n", ...extra }, "src/main.rs", prefix.split("\n").length + 1, "f");
    expect(edge).toBeDefined();
    expect(edge?.toSymbol).not.toBe("src/alias.rs#f");
  });

  // Round 7: a module's identity comes only from its declaration chain, never from the folder layout.
  it.each([
    ["super:: from a file child of an inline module", {
      "src/main.rs": "mod outer { pub fn f() -> &'static str { \"OUTER\" } pub mod child; }\nfn run() -> &'static str { outer::child::run() }\nfn main() { let _ = run(); }\n",
      "src/outer/child.rs": "pub fn run() -> &'static str {\n    super::f()\n}\n",
      "src/outer.rs": "pub fn f() -> &'static str { \"STRAY\" }\n",
    }, "src/outer/child.rs", 2, "src/outer.rs#f", "src/main.rs#outer.f"],
    ["super:: past a stray mod.rs to the declaring parent", {
      "src/main.rs": "mod outer;\nfn run() -> &'static str { outer::child::run() }\nfn main() { let _ = run(); }\n",
      "src/outer.rs": "pub fn f() -> &'static str { \"OUTER\" }\npub mod child;\n",
      "src/outer/child.rs": "pub fn run() -> &'static str {\n    super::f()\n}\n",
      "src/outer/mod.rs": "pub fn f() -> &'static str { \"STRAY\" }\n",
    }, "src/outer/child.rs", 2, "src/outer/mod.rs#f", "src/outer.rs#f"],
    ["self:: from a file a path attribute loads", {
      "src/main.rs": "#[path=\"chosen.rs\"] mod m;\nfn run() -> &'static str { m::run() }\nfn main() { let _ = run(); }\n",
      "src/chosen.rs": "pub mod child;\npub fn run() -> &'static str {\n    self::child::f()\n}\n",
      "src/child.rs": "pub fn f() -> &'static str { \"CHILD\" }\n",
      "src/chosen/child.rs": "pub fn f() -> &'static str { \"STRAY\" }\n",
    }, "src/chosen.rs", 3, "src/chosen/child.rs#f", "src/child.rs#f"],
    ["self:: from a root a single-quoted Cargo path names", {
      "Cargo.toml": "[package]\nname=\"app\"\nversion=\"0.1.0\"\nedition=\"2024\"\nautobins=false\n[[bin]]\nname=\"chosen\"\npath='src/chosen.rs'\n",
      "src/chosen.rs": "mod child;\nfn run() -> &'static str {\n    self::child::f()\n}\nfn main() { let _ = run(); }\n",
      "src/child.rs": "pub fn f() -> &'static str { \"CHILD\" }\n",
      "src/chosen/child.rs": "pub fn f() -> &'static str { \"STRAY\" }\n",
    }, "src/chosen.rs", 3, "src/chosen/child.rs#f", "src/child.rs#f"],
    ["self:: from a standalone file that is no known root", {
      "entry.rs": "mod child;\nfn run() -> &'static str {\n    self::child::f()\n}\nfn main() { let _ = run(); }\n",
      "child.rs": "pub fn f() -> &'static str { \"CHILD\" }\n",
      "entry/child.rs": "pub fn f() -> &'static str { \"STRAY\" }\n",
    }, "entry.rs", 3, "entry/child.rs#f", "child.rs#f"],
    ["a cfg-gated module next to a macro that may define the name", {
      "src/main.rs": "#[cfg(any())] mod alias;\nmacro_rules! define { () => { pub mod alias { pub fn f() -> &'static str { \"MACRO\" } } } }\ndefine!();\nfn run() -> &'static str {\n    crate::alias::f()\n}\nfn main() { let _ = run(); }\n",
      "src/alias.rs": "pub fn f() -> &'static str { \"STRAY\" }\n",
    }, "src/main.rs", 5, "src/alias.rs#f", undefined],
  ] as const)("never resolves %s to the folder-layout guess", async (_label, files, file, line, wrong, right) => {
    const edge = await target({ ...files }, file, line, "f");
    expect(edge).toBeDefined();
    expect(edge?.toSymbol).not.toBe(wrong);
    if (edge?.toSymbol !== undefined) expect(edge.toSymbol).toBe(right);
  });

  // Round 8.
  const otherPackage = "[package]\nname=\"other\"\nversion=\"0.1.0\"\nedition=\"2024\"\n";
  it.each([
    ["a renamed library target", { "other/Cargo.toml": otherPackage + "[lib]\npath=\"src/actual.rs\"\n", "other/src/actual.rs": "pub fn f() -> &'static str { \"LIB\" }\n", "other/src/lib.rs": "pub fn f() -> &'static str { \"STRAY\" }\n" }, "other/src/actual.rs#f", "other/src/lib.rs#f"],
    ["a single-quoted library target", { "other/Cargo.toml": otherPackage + "[lib]\npath='custom.rs'\n", "other/custom.rs": "pub fn f() -> &'static str { \"LIB\" }\n", "other/src/lib.rs": "pub fn f() -> &'static str { \"STRAY\" }\n" }, "other/custom.rs#f", "other/src/lib.rs#f"],
    ["a library beside a custom binary target", { "other/Cargo.toml": otherPackage + "[[bin]]\nname=\"tool\"\npath=\"tools/main.rs\"\n", "other/src/lib.rs": "pub fn f() -> &'static str { \"LIB\" }\n", "other/tools/main.rs": "pub fn f() -> &'static str { \"STRAY\" }\nfn main() {}\n" }, "other/src/lib.rs#f", "other/tools/main.rs#f"],
  ] as const)("names a workspace package's function in %s", async (_label, extra, right, wrong) => {
    const edge = await target({ "Cargo.toml": "[workspace]\nmembers=[\"other\", \"app\"]\n", "app/Cargo.toml": "[package]\nname=\"app\"\nversion=\"0.1.0\"\nedition=\"2024\"\n", "app/src/main.rs": "fn run() -> &'static str {\n    other::f()\n}\nfn main() { let _ = run(); }\n", ...extra }, "app/src/main.rs", 2, "f");
    expect(edge?.toSymbol).not.toBe(wrong);
    expect(edge?.toSymbol).toBe(right);
  });

  // Rust picks the module while it is present, but a cfg gate the index cannot see may remove it, so a collision
  // refuses (round 10).
  it("never names the workspace package for a local module of the same name", async () => {
    const edge = await target({
      "Cargo.toml": "[package]\nname=\"app\"\nversion=\"0.1.0\"\nedition=\"2024\"\n",
      "src/main.rs": "mod app;\nfn run() -> &'static str {\n    app::f()\n}\nfn main() { let _ = run(); }\n",
      "src/app.rs": "pub fn f() -> &'static str { \"MODULE\" }\n",
      "src/lib.rs": "pub fn f() -> &'static str { \"LIB\" }\n",
    }, "src/main.rs", 3, "f");
    expect(edge).toBeDefined();
    expect(edge?.toSymbol).not.toBe("src/lib.rs#f");
  });

  it.each([
    ["a macro whose name ends in a combining mark", { "src/main.rs": "#[cfg(any())] mod alias;\nmacro_rules! define\u0301 { () => { pub mod alias { pub fn f() -> &'static str { \"MACRO\" } } } }\ndefine\u0301!();\nfn run() -> &'static str {\n    crate::alias::f()\n}\nfn main() {}\n", "src/alias.rs": "pub fn f() -> &'static str { \"STRAY\" }\n" }, "src/main.rs", 5, "src/alias.rs#f"],
    ["a child of an inline module a path attribute moves", { "Cargo.toml": "[package]\nname=\"app\"\nversion=\"0.1.0\"\nedition=\"2024\"\nautobins=false\n", "src/main.rs": "#[path=\"bin\"] mod outer { pub mod tool; }\npub fn f() -> &'static str { \"MAIN\" }\nfn main() {}\n", "src/bin/tool.rs": "pub fn f() -> &'static str { \"TOOL\" }\npub fn run() -> &'static str {\n    crate::f()\n}\n" }, "src/bin/tool.rs", 3, "src/bin/tool.rs#f"],
    ["a child of a cfg-disabled inline parent", { "src/main.rs": "#[cfg(any())] mod outer { pub fn f() -> &'static str { \"DISABLED\" }\npub mod child; }\nfn main() {}\n", "src/outer/child.rs": "pub fn run() -> &'static str {\n    super::f()\n}\n" }, "src/outer/child.rs", 2, "src/main.rs#outer.f"],
  ] as const)("never resolves through %s", async (_label, files, file, line, wrong) => {
    const edge = await target({ ...files }, file, line, "f");
    expect(edge).toBeDefined();
    expect(edge?.toSymbol).not.toBe(wrong);
  });

  // Round 9: regressions against the base branch.
  it.each([
    ["an inline module", { "src/main.rs": "#[cfg(any())] mod other { pub fn f() -> &'static str { \"DISABLED\" } }\nfn run() -> &'static str {\n    other::f()\n}\nfn main() {}\n" }, "src/main.rs#other.f"],
    ["a module file", { "src/main.rs": "#[cfg(any())] mod other;\nfn run() -> &'static str {\n    other::f()\n}\nfn main() {}\n", "src/other.rs": "pub fn f() -> &'static str { \"DISABLED\" }\n" }, "src/other.rs#f"],
  ] as const)("never names a cfg-disabled %s over the workspace package of its name", async (_label, files, wrong) => {
    const edge = await target({ "Cargo.toml": "[package]\nname=\"app\"\nversion=\"0.1.0\"\nedition=\"2024\"\n", "other/Cargo.toml": "[package]\nname=\"other\"\nversion=\"0.1.0\"\nedition=\"2024\"\n", "other/src/lib.rs": "pub fn f() -> &'static str { \"LIB\" }\n", ...files }, "src/main.rs", 3, "f");
    expect(edge).toBeDefined();
    expect(edge?.toSymbol).not.toBe(wrong);
  });

  it.each([
    ["a moved inline module inside a plain one", "mod outer { #[path=\"../bin\"] pub mod moved { pub mod tool; } }\n"],
    ["two moved inline modules", "#[path=\"custom\"] mod outer { #[path=\"../bin\"] pub mod moved { pub mod tool; } }\n"],
    ["a path-attribute child of a moved inline module", "#[path=\"custom/deep\"] mod outer { #[path=\"../../bin/tool.rs\"] pub mod tool; }\n"],
  ])("never takes the child of %s for a crate root", async (_label, prefix) => {
    const edge = await target({
      "Cargo.toml": "[package]\nname=\"app\"\nversion=\"0.1.0\"\nedition=\"2024\"\nautobins=false\n",
      "src/main.rs": prefix + "pub fn f() -> &'static str { \"ROOT\" }\nfn main() {}\n",
      "src/outer/placeholder.rs": "",
      "src/bin/tool.rs": "pub fn f() -> &'static str { \"TOOL\" }\npub fn run() -> &'static str {\n    crate::f()\n}\n",
    }, "src/bin/tool.rs", 3, "f");
    expect(edge).toBeDefined();
    expect(edge?.toSymbol).not.toBe("src/bin/tool.rs#f");
  });

  // Round 10: regressions against the base branch.
  it.each([
    ["a cfg gate before an attribute with nested brackets", { "src/main.rs": "#[cfg(any())]\n#[doc = stringify!([x])]\nmod other { pub fn f() -> &'static str { \"DISABLED\" } }\nfn run() -> &'static str {\n    other::f()\n}\nfn main() {}\n" }, 5, "src/main.rs#other.f"],
    ["an inner cfg gate", { "src/main.rs": "mod other { #![cfg(any())]\npub fn f() -> &'static str { \"DISABLED\" } }\nfn run() -> &'static str {\n    other::f()\n}\nfn main() {}\n" }, 4, "src/main.rs#other.f"],
    ["an inner cfg gate in a module file", { "src/main.rs": "mod other;\nfn run() -> &'static str {\n    other::f()\n}\nfn main() {}\n", "src/other.rs": "#![cfg(any())]\npub fn f() -> &'static str { \"DISABLED\" }\n" }, 3, "src/other.rs#f"],
  ] as const)("never names a local module behind %s over the workspace package of its name", async (_label, files, line, wrong) => {
    const edge = await target({ "Cargo.toml": "[package]\nname=\"app\"\nversion=\"0.1.0\"\nedition=\"2024\"\n", "other/Cargo.toml": "[package]\nname=\"other\"\nversion=\"0.1.0\"\nedition=\"2024\"\n", "other/src/lib.rs": "pub fn f() -> &'static str { \"LIB\" }\n", ...files }, "src/main.rs", line, "f");
    expect(edge).toBeDefined();
    expect(edge?.toSymbol).not.toBe(wrong);
  });

  it("never takes the child of an inline module with an inner path attribute for a crate root", async () => {
    const edge = await target({
      "Cargo.toml": "[package]\nname=\"app\"\nversion=\"0.1.0\"\nedition=\"2024\"\nautobins=false\n",
      "src/main.rs": "mod outer { #![path = \"bin\"]\npub mod tool; }\npub fn f() -> &'static str { \"ROOT\" }\nfn main() {}\n",
      "src/bin/tool.rs": "pub fn f() -> &'static str { \"TOOL\" }\npub fn run() -> &'static str {\n    crate::f()\n}\n",
    }, "src/bin/tool.rs", 3, "f");
    expect(edge).toBeDefined();
    expect(edge?.toSymbol).not.toBe("src/bin/tool.rs#f");
  });

  // Round 11: an attribute deeper than three bracket levels may hide a path.
  it.each([
    ["an outer attribute", "#[cfg_attr(all(), doc = stringify!([[[x]]]), path = \"bin\")]\nmod outer { pub mod tool; }\n"],
    ["an inner attribute", "mod outer {\n    #![cfg_attr(all(), doc = stringify!([[[x]]]), path = \"bin\")]\n    pub mod tool;\n}\n"],
    ["a path before a deep attribute", "#[path = \"bin\"]\n#[doc = stringify!([[[x]]])]\nmod outer { pub mod tool; }\n"],
  ])("never takes a child moved by a path behind %s with deep brackets for a crate root", async (_label, prefix) => {
    const edge = await target({
      "Cargo.toml": "[package]\nname=\"app\"\nversion=\"0.1.0\"\nedition=\"2024\"\nautobins=false\n",
      "src/main.rs": prefix + "pub fn f() -> &'static str { \"ROOT\" }\nfn main() {}\n",
      "src/bin/tool.rs": "pub fn f() -> &'static str { \"TOOL\" }\npub fn run() -> &'static str {\n    crate::f()\n}\n",
    }, "src/bin/tool.rs", 3, "f");
    expect(edge).toBeDefined();
    expect(edge?.toSymbol).not.toBe("src/bin/tool.rs#f");
  });

  // Round 12: a path attribute in any spelling the scanner might miss.
  it.each([
    ["a space after the hash", "# [path = \"bin\"]\nmod outer { pub mod tool; }\n"],
    ["a comment after the hash", "#/* c */[path = \"bin\"]\nmod outer { pub mod tool; }\n"],
    ["many spaces before a deep attribute", "#        [cfg_attr(all(), doc = stringify!([[[x]]]), path = \"bin\")]\nmod outer { pub mod tool; }\n"],
    ["many spaces in a deep inner attribute", "mod outer {\n    #!        [cfg_attr(all(), doc = stringify!([[[x]]]), path = \"bin\")]\n    pub mod tool;\n}\n"],
    ["a raw identifier", "#[r#path = \"bin\"]\nmod outer { pub mod tool; }\n"],
    ["NEXT LINE before the equals sign", "#[path\u0085= \"bin\"]\nmod outer { pub mod tool; }\n"],
    ["a direction mark before the equals sign", "#[path\u200e= \"bin\"]\nmod outer { pub mod tool; }\n"],
  ])("never takes a child moved by a path attribute with %s for a crate root", async (_label, prefix) => {
    const edge = await target({
      "Cargo.toml": "[package]\nname=\"app\"\nversion=\"0.1.0\"\nedition=\"2024\"\nautobins=false\n",
      "src/main.rs": prefix + "pub fn f() -> &'static str { \"ROOT\" }\nfn main() {}\n",
      "src/bin/tool.rs": "pub fn f() -> &'static str { \"TOOL\" }\npub fn run() -> &'static str {\n    crate::f()\n}\n",
    }, "src/bin/tool.rs", 3, "f");
    expect(edge).toBeDefined();
    expect(edge?.toSymbol).not.toBe("src/bin/tool.rs#f");
  });

  // Round 13: only one plain path attribute on a declaration is followed.
  it.each([
    ["an inactive path before the active one", "#[cfg_attr(any(), path = \"bin/unused.rs\")]\n#[path = \"bin/tool.rs\"]\nmod tool;\n"],
    ["a nested inactive path", "#[cfg_attr(all(), cfg_attr(any(), path = \"bin/unused.rs\"), path = \"bin/tool.rs\")]\nmod tool;\n"],
    ["a path assignment inside a doc token", "#[doc = stringify!(path = \"bin/unused.rs\")]\n#[path = \"bin/tool.rs\"]\nmod tool;\n"],
  ])("never takes a child behind %s for a crate root", async (_label, prefix) => {
    const edge = await target({
      "Cargo.toml": "[package]\nname=\"app\"\nversion=\"0.1.0\"\nedition=\"2024\"\nautobins=false\n",
      "src/main.rs": prefix + "pub fn f() -> &'static str { \"ROOT\" }\nfn main() {}\n",
      "src/bin/unused.rs": "pub fn unused() {}\n",
      "src/bin/tool.rs": "pub fn f() -> &'static str { \"TOOL\" }\npub fn run() -> &'static str {\n    crate::f()\n}\n",
    }, "src/bin/tool.rs", 3, "f");
    expect(edge).toBeDefined();
    expect(edge?.toSymbol).not.toBe("src/bin/tool.rs#f");
  });

  // Round 14: an explicit Cargo target that another file also declares as a module.
  const bins = "[package]\nname=\"app\"\nversion=\"0.1.0\"\nedition=\"2024\"\nautobins=false\n[[bin]]\nname=\"tool\"\npath=\"src/bin/tool.rs\"\n[[bin]]\nname=\"owner\"\npath=";
  it.each([
    ["a disabled path declaration", "custom/owner.rs", "#[cfg(any())]\n#[path=\"../src/bin/tool.rs\"]mod child;\n"],
    ["an active path declaration", "custom/owner.rs", "#[cfg(all())]\n#[path=\"../src/bin/tool.rs\"]mod child;\n"],
    ["a plain path declaration", "custom/owner.rs", "#[path=\"../src/bin/tool.rs\"]mod child;\n"],
    ["a disabled conventional declaration", "src/bin/owner.rs", "#[cfg(any())]\nmod tool;\n"],
    ["an active conventional declaration", "src/bin/owner.rs", "#[cfg(all())]\nmod tool;\n"],
  ])("never reads crate:: in an explicit Cargo target that %s also names as another target's", async (_label, owner, declaration) => {
    const edge = await target({
      "Cargo.toml": `${bins}"${owner}"\n`,
      [owner]: declaration + "pub fn f() -> &'static str { \"OWNER\" }\nfn main() {}\n",
      "src/bin/tool.rs": "pub fn f() -> &'static str { \"TOOL\" }\nfn run() -> &'static str {\n    crate::f()\n}\nfn main() { let _ = run(); }\n",
    }, "src/bin/tool.rs", 3, "f");
    expect(edge).toBeDefined();
    expect(edge?.toSymbol).not.toBe(`${owner}#f`);
  });

  it("still follows a cfg-gated module whose name nothing else binds", async () => {
    const edge = await target({
      "src/lib.rs": "#[cfg(feature = \"serde\")]\npub use crate::json::JSONBuilder;\n#[cfg(feature = \"serde\")]\nmod json;\nfn make() {\n    let _ = crate::json::build();\n}\n",
      "src/json.rs": "pub struct JSONBuilder;\npub fn build() {}\n",
    }, "src/lib.rs", 6, "build");
    expect(edge?.toSymbol).toBe("src/json.rs#build");
  });

  const local = "fn f() -> &'static str { \"LOCAL\" }\npub fn run() -> &'static str {\n    crate::f()\n}\n";
  it.each([
    ["a raw-identifier declaration", { "tests/basic.rs": "mod r#common;\nfn f() -> &'static str { \"ROOT\" }\nfn run() -> &'static str { common::run() }\nfn main() { let _ = run(); }\n", "tests/common.rs": local }, "tests/common.rs", "tests/basic.rs#f"],
    ["a file child of an inline module", { "src/main.rs": "fn f() -> &'static str { \"ROOT\" }\nmod outer { pub mod main; }\nfn run() -> &'static str { outer::main::run() }\nfn main() { let _ = run(); }\n", "src/outer/main.rs": local }, "src/outer/main.rs", "src/main.rs#f"],
    ["a path-attribute declaration", { "src/main.rs": "fn f() -> &'static str { \"ROOT\" }\n#[path=\"nested/main.rs\"] mod child;\nfn run() -> &'static str { child::run() }\nfn main() { let _ = run(); }\n", "src/nested/main.rs": local }, "src/nested/main.rs", "src/main.rs#f"],
    ["a custom Cargo target root", { "Cargo.toml": "[package]\nname=\"app\"\nversion=\"0.1.0\"\nedition=\"2024\"\n[[bin]]\nname=\"chosen\"\npath=\"src/chosen.rs\"\n", "src/chosen.rs": "mod main;\nfn f() -> &'static str { \"CUSTOM\" }\nfn run() -> &'static str { main::run() }\nfn main() { let _ = run(); }\n", "src/main.rs": local }, "src/main.rs", "src/chosen.rs#f"],
  ] as const)("reads crate:: in a module declared by %s as its declaring crate, never as a root", async (_label, files, file, root) => {
    const edge = await target({ ...files }, file, 3, "f");
    expect(edge?.toSymbol).not.toBe(`${file}#f`);
    if (edge?.toSymbol !== undefined) expect(edge.toSymbol).toBe(root);
  });
});

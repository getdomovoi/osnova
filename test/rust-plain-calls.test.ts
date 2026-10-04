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

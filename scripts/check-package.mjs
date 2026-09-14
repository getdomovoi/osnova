import assert from "node:assert/strict";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function checkFrames(stdout) {
  assert(stdout.length > 0, "No protocol frames observed");
  assert(stdout.endsWith("\n"), "Unterminated stdout frame");
  const lines = stdout.slice(0, -1).split("\n");
  for (const line of lines) {
    const frame = JSON.parse(line);
    assert.equal(frame.jsonrpc, "2.0", "Non-protocol stdout");
    assert(typeof frame.method === "string" || ("id" in frame && ("result" in frame || "error" in frame)), "Invalid JSON-RPC envelope");
  }
  return lines.length;
}

export async function checkPackage(root) {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "@getdomovoi/osnova");
  const targets = [manifest.main, manifest.types, manifest.bin?.osnova];
  for (const name of [".", "./cli", "./mcp"]) assert(manifest.exports[name], `Missing export ${name}`);
  for (const entry of Object.values(manifest.exports)) {
    assert.equal(typeof entry.import, "string");
    assert.equal(typeof entry.types, "string");
    targets.push(entry.import, entry.types);
  }
  for (const target of targets) {
    assert(typeof target === "string" && target.startsWith("./dist/"), "Package target must be inside dist");
    const resolved = path.resolve(root, target);
    assert(!path.relative(path.join(root, "dist"), resolved).startsWith(".."), "Escaping package target");
    assert((await stat(resolved)).isFile(), `Missing artifact ${target}`);
  }
  assert((await readFile(path.join(root, manifest.bin.osnova), "utf8")).startsWith("#!/usr/bin/env node\n"), "Missing executable shebang");
  assert.equal(manifest.dependencies["web-tree-sitter"], "0.25.10");
  assert.equal(manifest.dependencies["tree-sitter-wasms"], "0.1.13");
  return manifest;
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  await checkPackage(path.resolve(process.argv[2] ?? "."));
  console.log("package structure: exports, declarations, executable and pinned WASM dependencies verified");
}

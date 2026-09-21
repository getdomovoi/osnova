import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { checkFrames, checkPackage } from "./check-package.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const samples = {
  "probe.ts": "export function probe() { return 1; }\nexport function caller() { return probe(); }\n",
  "component.tsx": "export const component = <div />;\n",
  "script.js": "export function script() { return 1; }\n",
  "probe.py": "def probe_python():\n    return 1\n",
  "probe.go": "package probe\nfunc Probe() {}\n",
  "probe.rs": "fn probe_rust() {}\n",
  "Probe.java": "class Probe { void run() {} }\n",
  "Probe.cs": "class Probe { void Run() {} }\n",
  "probe.c": "int probe_c(void) { return 1; }\n",
  "probe.cpp": "int probe_cpp() { return 1; }\n",
  "probe.m": "@implementation Probe\n- (int)probeObjc { return 1; }\n@end\n",
  "probe.rb": "def probe_ruby\n  1\nend\n",
  "probe.php": "<?php\nfunction probe_php() { return 1; }\n",
  "Probe.kt": "fun probeKotlin(): Int { return 1 }\n",
  "probe.swift": "func probeSwift() -> Int { return 1 }\n",
  "Probe.scala": "object Probe { def probeScala(): Int = 1 }\n",
  "probe.dart": "int probeDart() { return 1; }\n",
  "probe.ex": "defmodule Probe do\n  def probe_elixir do\n    1\n  end\nend\n",
  "probe.ml": "let probe_ocaml () = 1\n",
  "probe.zig": "fn probeZig() i32 { return 1; }\n",
  "probe.sh": "probe_bash() { echo 1; }\n",
};

async function snapshot(root) {
  const files = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const target = path.join(root, entry.name);
    files.push([entry.name, entry.isDirectory() ? await snapshot(target) : createHash("sha256").update(await readFile(target)).digest("hex")]);
  }
  return files;
}

async function consumer() {
  const root = process.cwd();
  const rootBefore = await readdir(root);
  const packageRoot = path.join(root, "node_modules/@getdomovoi/osnova");
  const manifest = await checkPackage(packageRoot);
  const packageBefore = await snapshot(packageRoot);
  assert((await realpath(packageRoot)).startsWith(await realpath(root)), "Package must be extracted, not linked to checkout");
  const api = await import("@getdomovoi/osnova");
  for (const name of ["buildIndex", "loadIndex", "refreshWorkspace", "indexGeneration", "evidenceFingerprint", "applyChanges", "freshness", "scanFiles", "ask", "findText", "skeleton", "callers", "map", "renderMapCard", "impact", "scopedAsk", "taskContext", "doctor", "configureLspEnrichment", "loadLspEnrichment", "refreshLspEnrichment", "runMcpStdio"]) assert.equal(typeof api[name], "function", `Missing API ${name}`);
  for (const entry of Object.keys(manifest.exports)) await import(entry === "." ? manifest.name : manifest.name + entry.slice(1));
  const workspace = path.join(root, "workspace");
  const cacheDir = path.join(root, "cache");
  await mkdir(workspace);
  for (const [file, source] of Object.entries(samples)) await writeFile(path.join(workspace, file), source);
  const before = await snapshot(workspace);
  const index = await api.buildIndex(workspace, { cacheDir });
  for (const file of Object.keys(samples)) assert(api.skeleton(index, file).entries.length > 0, `Grammar/extraction failed: ${file}`);
  assert(api.ask(index, "probe").hits.length > 0);
  const scanned = await api.scanFiles(workspace, cacheDir);
  assert(Array.isArray(scanned.paths) && scanned.paths.length > 0, "scanFiles returned no paths");
  assert.deepEqual(scanned.paths, [...scanned.paths].sort(), "scanFiles paths must be sorted");
  assert.deepEqual(await snapshot(workspace), before, "Core build mutated workspace");
  const diagnostics = await import(pathToFileURL(path.join(packageRoot, "dist/diagnostics.js")).href);
  const report = await diagnostics.doctor(workspace, { cacheDir });
  assert(report.ok, "Packed doctor failed runtime/assets checks");
  assert.deepEqual(await snapshot(workspace), before, "Diagnostics mutated workspace");

  const frames = await smokeStdio({ cliPath: path.join(packageRoot, manifest.bin.osnova), workspace, cacheDir, cwd: root });
  assert.deepEqual(await snapshot(packageRoot), packageBefore, "Core operations mutated installed package");
  assert.deepEqual((await readdir(root)).sort(), [...new Set([...rootBefore, "cache", "workspace"])].sort(), "Core operations wrote outside designated cache/workspace fixtures");
  console.log(`packed consumer: exports, 21 WASM grammars, doctor, build/ask, 8 MCP tools, refresh, EOF shutdown; ${frames} clean stdout frames`);
}

export async function smokeStdio({ cliPath, workspace, cacheDir, cwd, nodeArgs = [], omitWorkspaceArg = false }) {
  const before = await snapshot(workspace);
  const errors = [];
  let stdout = "";
  let stderr = "";
  let child;
  let closed;
  class ObservedTransport extends StdioClientTransport {
    async start() {
      await super.start();
      child = this._process;
      assert(child, "SDK did not expose spawned process for framing observation");
      closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > 1_048_576) { errors.push(new Error("stdout exceeded smoke budget")); void this.close(); }
      });
    }
  }
  const transport = new ObservedTransport({
    command: process.execPath,
    args: [...nodeArgs, cliPath, "mcp", ...(omitWorkspaceArg ? [] : ["--workspace", workspace])],
    cwd,
    env: { OSNOVA_CACHE_DIR: cacheDir, HOME: path.join(cacheDir, "smoke-home"), USERPROFILE: path.join(cacheDir, "smoke-home"), TSX_DISABLE_CACHE: "1" },
    stderr: "pipe",
  });
  transport.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-65_536); });
  const client = new Client({ name: "osnova-package-smoke", version: "1.0.0" });
  client.onerror = (error) => errors.push(error);
  const deadline = setTimeout(() => { errors.push(new Error("MCP child exceeded 30 second lifetime")); void transport.close(); }, 30_000);
  let frames;
  try {
    await client.connect(transport, { timeout: 10_000 });
    assert.equal(client.getServerVersion()?.name, "osnova");
    const tools = await client.listTools({}, { timeout: 10_000 });
    const calls = {
      osnova_ground: { question: "probe" },
      osnova_thread: { pattern: "probe", fixed: true },
      osnova_outline: { file: "probe.ts" },
      osnova_warp: { symbol: "probe" },
      osnova_groundwork: {},
      osnova_footing: { question: "probe" },
      osnova_settle: { diff: "--- a/probe.ts\n+++ b/probe.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n" },
      osnova_plumb: { symbol: "probe", sites: ["probe.ts:2"] },
      osnova_tests: { symbols: ["probe"] },
      osnova_unreferenced: { includeExported: true },
    };
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), Object.keys(calls).sort());
    for (const [name, args] of Object.entries(calls)) {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
      assert(!result.isError, `${name} returned an error`);
      assert(result.content.some((item) => item.type === "text" && item.text.length > 0), `${name} returned no text`);
      if (name !== "osnova_groundwork") assert(JSON.stringify(result.content).includes(name === "osnova_warp" ? "caller" : name === "osnova_settle" ? "settle" : name === "osnova_plumb" ? "plumb" : name === "osnova_unreferenced" ? "unreferenced" : "probe"), `${name} omitted expected evidence`);
    }
    assert.deepEqual(await snapshot(workspace), before, "MCP tools mutated workspace");
    await writeFile(path.join(workspace, "probe.ts"), "export function refreshedProbe() { return 2; }\n");
    const edited = await snapshot(workspace);
    const refreshed = await client.callTool({ name: "osnova_outline", arguments: { file: "probe.ts" } }, undefined, { timeout: 10_000 });
    assert(!refreshed.isError && JSON.stringify(refreshed.content).includes("refreshedProbe"), "MCP did not refresh source edit");
    assert.deepEqual(await snapshot(workspace), edited, "Refresh mutated workspace");
    child.stdin.end();
    const exit = await closed;
    assert.deepEqual(exit, { code: 0, signal: null }, "MCP must exit cleanly on stdin EOF");
    assert.equal(errors.length, 0, "MCP emitted transport/protocol errors");
    assert.equal(stderr, "", "Successful MCP run emitted stderr");
    frames = checkFrames(stdout);
    assert(frames >= 8, "Missing expected protocol responses");
  } finally {
    clearTimeout(deadline);
    await client.close();
    await transport.close();
    if (closed) await closed;
  }
  return frames;
}

async function packAndTest() {
  const checkout = path.resolve(scriptDir, "..");
  await checkPackage(checkout);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "osnova-package-"));
  try {
    const home = path.join(scratch, "home");
    await mkdir(home);
    const args = ["pack", "--ignore-scripts", "--offline", "--json", "--cache", path.join(scratch, "npm-cache"), "--pack-destination", scratch];
    const windows = process.platform === "win32";
    const output = execFileSync(windows ? "npm.cmd" : "npm", windows ? args.map((arg) => `"${arg}"`) : args, {
      cwd: checkout, encoding: "utf8", timeout: 60_000, shell: windows,
      env: { ...process.env, npm_config_update_notifier: "false", npm_config_userconfig: path.join(home, ".npmrc"), npm_config_globalconfig: path.join(home, "global-npmrc") },
    });
    const [{ filename }] = JSON.parse(output);
    assert.equal(path.basename(filename), filename);
    const archive = path.join(scratch, filename);
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", timeout: 10_000 }).trim().split(/\r?\n/);
    assert(entries.every((entry) => entry.startsWith("package/") && !entry.split("/").includes("..")), "Unsafe archive path");
    const consumerRoot = path.join(scratch, "consumer");
    const packageRoot = path.join(consumerRoot, "node_modules/@getdomovoi/osnova");
    await mkdir(packageRoot, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", packageRoot], { timeout: 10_000 });
    const manifest = await checkPackage(packageRoot);
    for (const name of Object.keys(manifest.dependencies)) {
      const target = path.join(consumerRoot, "node_modules", name);
      await mkdir(path.dirname(target), { recursive: true });
      await symlink(await realpath(path.join(checkout, "node_modules", name)), target, "junction");
    }
    await cp(path.join(scriptDir, "package-smoke.mjs"), path.join(consumerRoot, "package-smoke.mjs"));
    await cp(path.join(scriptDir, "check-package.mjs"), path.join(consumerRoot, "check-package.mjs"));
    const result = execFileSync(process.execPath, [path.join(consumerRoot, "package-smoke.mjs"), "--consumer"], {
      cwd: consumerRoot, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "", HOME: home, USERPROFILE: home, OSNOVA_CACHE_DIR: path.join(consumerRoot, "cache") },
    });
    assert(result.includes("packed consumer: exports, 21 WASM grammars"), "Consumer validation did not execute");
    console.log(result.trim());
    console.log(`artifact: ${filename}; ${entries.length} archive entries; isolated consumer outside checkout with existing dependency links; no install/download/native compilation`);
    console.log("clean registry-backed install: run separately with scripts/clean-install-smoke.mjs");
  } finally {
    await readdir(scratch);
    await rm(scratch, { recursive: true, force: true });
  }
  console.log("temporary archive, consumer, cache and child processes cleaned");
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === "--consumer") await consumer();
  else await packAndTest();
}

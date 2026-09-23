import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// SHA-256 of every file tree-sitter-wasms@0.1.13 ships under out/, taken from the registry tarball whose sha512
// matches pnpm-lock.yaml. The package has one maintainer and no build provenance, and its build cannot be
// reproduced, so a lockfile hash says only that the bytes did not change since the lock was written. These
// digests make any republish or local change to an executed grammar fail the gate instead of an index build.
const grammarDigests = {
  "tree-sitter-bash.wasm": "807dcdb1380a59befb112ed8fbd3d3872c7fadaf5903a769282b50973b30696d",
  "tree-sitter-c.wasm": "056b25072382f72deee2c64ec238ffc4bb8cf42844ef21502c0e70f03a8a0d66",
  "tree-sitter-c_sharp.wasm": "6266a7e32d68a3459104d994dc848df15d5672b0ea8e86d327274b694f8e6991",
  "tree-sitter-cpp.wasm": "f6afdf53bfd6de76557bb7edb624a3a3869e14d9a83b78433f93617ecee42527",
  "tree-sitter-css.wasm": "5fc615467b1b98420ed7517e5bf9e1f88468132dd903d842dfb13714f6a1cb0c",
  "tree-sitter-dart.wasm": "7f5364e4256cf7e55efd01dd52421ef2663caa8061b82659b7e4bf61064545ec",
  "tree-sitter-elisp.wasm": "deedb03ccf150329ddfcc4ed92861c235bbae6f9692be6b93cac71617a4d42ab",
  "tree-sitter-elixir.wasm": "82e91b9759ddca30d8978ebbfa8e347b4451b64c931f9ae62112e6db9b8fac20",
  "tree-sitter-elm.wasm": "962b8668a0e16a6fb1fe232ba3e07ba4537a6b72c47293fddea0f6ea6ff9912e",
  "tree-sitter-embedded_template.wasm": "68584527f712dbf2cc39776c56980c08516991f184a4a17bb67c2f436f0fc373",
  "tree-sitter-go.wasm": "9963ca89b616eaf04b08a43bc1fb0f07b85395bec313330851f1f1ead2f755b6",
  "tree-sitter-html.wasm": "11b3405c1543fb012f5ed7f8ee73125076dce8b168301e1e787e4c717da6b456",
  "tree-sitter-java.wasm": "637aac4415fb39a211a4f4292d63c66b5ce9c32fa2cd35464af4f681d91b9a1f",
  "tree-sitter-javascript.wasm": "63812b9e275d26851264734868d27a1656bd44a2ef6eb3e85e6b03728c595ab5",
  "tree-sitter-json.wasm": "fdb5219abe058369e16897aaa11eecf47ef4f546752c3ddbac339cdd89e1e667",
  "tree-sitter-kotlin.wasm": "b5cb00c8d06ed0f10f1dbe497205b437809d7e87db1f638721a8cfb30e044449",
  "tree-sitter-lua.wasm": "75ef809136d610068c5b2135741d89f5df62690a3d55169203351cb7cc85727d",
  "tree-sitter-objc.wasm": "7c1b5bfdca7e64b6c63b6040bb7ba0afc347df116f9030ca32f8535d7377f6ff",
  "tree-sitter-ocaml.wasm": "60849b6320ee956233d77b017c65c45660e507d03ae70aa1bd5783458e2e9e18",
  "tree-sitter-php.wasm": "55bb617b6f01e14bab997861f0b20a2420cf6ba3199ffeb295b9ec398966d8a3",
  "tree-sitter-python.wasm": "9056d0fb0c337810d019fae350e8167786119da98f0f282aceae7ab89ee8253b",
  "tree-sitter-ql.wasm": "836b2a51f6b2b4605ef7bfa908b978fed0fe838afb4eabaa9451552f12e953c1",
  "tree-sitter-rescript.wasm": "ae18d46336768b6c0eea07eb0b003408848766b3b67df1d807b40cbd93017bda",
  "tree-sitter-ruby.wasm": "93a5022855314cdb45458c7bb026a24a0ebc3a5ff6439e542e881f14dfa13a39",
  "tree-sitter-rust.wasm": "4409921a70d0aa5bec7d1d7ce809a557a8ee1cf6ace901e3ac6a76e62cfea903",
  "tree-sitter-scala.wasm": "160cfbb8ff7220886e99ed9699abceb6d837b4cd28993b9282c7f445a0554abd",
  "tree-sitter-solidity.wasm": "160745e470f234cae903a9ba445d19e758d0b02e1197401fc765976c6254d2b6",
  "tree-sitter-swift.wasm": "41c4fdb2249a3aa6d87eed0d383081ff09725c2248b4977043a43825980ffcc7",
  "tree-sitter-systemrdl.wasm": "09129542bbea6d19aa33b54f93bae2b41128144970be13ce09af6697146c4527",
  "tree-sitter-tlaplus.wasm": "72a07f94b0bc88b9123a6e41058e37ab9ca70d84a03b79511b25af7f435129b5",
  "tree-sitter-toml.wasm": "7849ac8ce9d10a4684ca189ea8ad3654c20c38acb2d674a014a164398cbd37a2",
  "tree-sitter-tsx.wasm": "6aa3b2c70e76f5d48eafef1093e9c4de383e13f2fdde2f4e9b98a378f6a8f1b6",
  "tree-sitter-typescript.wasm": "8515404dceed38e1ed86aa34b09fcf3379fff1b4ff9dd3967bcd6d1eb5ac3d8f",
  "tree-sitter-vue.wasm": "6244521bb3fb60f34ce5f677f2af81facb2c38691193985ca5fa85e1b6f29250",
  "tree-sitter-yaml.wasm": "5dea7cfff83d41d8f87fb8e434e1a5b292c0d670bfcdc42cb2af420ef490dde5",
  "tree-sitter-zig.wasm": "59cc4531aa661e2de4c5bc04e4045b6bdd5d2bfa75045cbda5f673102d140eef",
};

// 95 installed packages at the time of writing, all but a handful through @modelcontextprotocol/sdk's HTTP and
// OAuth stack, which the stdio server never loads. The ceiling makes growth a reviewed change, not a silent one.
const runtimeTreeCeiling = 110;

export async function checkGrammarDigests(root) {
  const dir = path.join(root, "node_modules/tree-sitter-wasms/out");
  const manifest = JSON.parse(await readFile(path.join(root, "node_modules/tree-sitter-wasms/package.json"), "utf8"));
  assert.equal(manifest.version, "0.1.13", "grammarDigests were recorded for tree-sitter-wasms 0.1.13");
  const names = (await readdir(dir)).sort();
  const expected = Object.keys(grammarDigests).sort();
  for (const name of names) assert(name in grammarDigests, `tree-sitter-wasms ships an unrecorded file ${name}`);
  for (const name of expected) assert(names.includes(name), `tree-sitter-wasms is missing ${name}`);
  for (const name of names) {
    const digest = createHash("sha256").update(await readFile(path.join(dir, name))).digest("hex");
    assert.equal(digest, grammarDigests[name], `${name} does not match its recorded SHA-256`);
  }
  return names.length;
}

async function installedPackage(from, name) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (await stat(path.join(candidate, "package.json")).then(() => true, () => false)) return realpath(candidate);
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** Every installed package reachable from the manifest's runtime dependencies, as sorted name@version. */
export async function runtimePackages(root) {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const found = new Map();
  const pending = [
    ...Object.keys(manifest.dependencies ?? {}).map((name) => ({ from: root, name, optional: false })),
    ...Object.keys(manifest.optionalDependencies ?? {}).map((name) => ({ from: root, name, optional: true })),
  ];
  while (pending.length > 0) {
    const { from, name, optional } = pending.pop();
    const dir = await installedPackage(from, name);
    if (dir === undefined) {
      assert(optional, `runtime dependency ${name} is not installed below ${from}`);
      continue;
    }
    if (found.has(dir)) continue;
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    found.set(dir, `${pkg.name}@${pkg.version}`);
    for (const dependency of Object.keys(pkg.dependencies ?? {})) pending.push({ from: dir, name: dependency, optional: false });
    for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) pending.push({ from: dir, name: dependency, optional: true });
  }
  return [...new Set(found.values())].sort();
}

export async function checkRuntimeTree(root, ceiling = runtimeTreeCeiling) {
  const count = (await runtimePackages(root)).length;
  assert(count <= ceiling, `runtime dependency tree grew to ${count} packages (ceiling ${ceiling}); review the new packages, then raise the ceiling deliberately`);
  return count;
}

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
  for (const name of [".", "./cli", "./mcp", "./diagnostics", "./enrichment"]) assert(manifest.exports[name], `Missing export ${name}`);
  for (const entry of Object.values(manifest.exports)) {
    assert.equal(typeof entry.import, "string");
    assert.equal(typeof entry.types, "string");
    targets.push(entry.import, entry.types);
  }
  for (const target of targets) {
    assert(typeof target === "string" && /^(\.\/)?dist\//.test(target), "Package target must be inside dist");
    const resolved = path.resolve(root, target);
    assert(!path.relative(path.join(root, "dist"), resolved).startsWith(".."), "Escaping package target");
    assert((await stat(resolved)).isFile(), `Missing artifact ${target}`);
  }
  assert((await readFile(path.join(root, manifest.bin.osnova), "utf8")).startsWith("#!/usr/bin/env node\n"), "Missing executable shebang");
  assert.equal(manifest.dependencies["web-tree-sitter"], "0.25.10");
  assert.equal(manifest.dependencies["tree-sitter-wasms"], "0.1.13");
  const distIndex = await readFile(path.join(root, "dist/index.js"), "utf8");
  for (const name of ["buildIndex", "loadIndex", "scanFiles"]) {
    assert(new RegExp(`\\b${name}\\b`).test(distIndex), `Missing ${name} export in dist/index.js`);
  }
  return manifest;
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const root = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? ".");
  await checkPackage(root);
  console.log("package structure: exports, declarations, executable and pinned WASM dependencies verified");
  if (args.includes("--supply-chain")) {
    const grammars = await checkGrammarDigests(root);
    const runtime = await checkRuntimeTree(root);
    console.log(`supply chain: ${grammars} grammar blobs match their recorded SHA-256; ${runtime} runtime packages (ceiling ${runtimeTreeCeiling})`);
  }
}

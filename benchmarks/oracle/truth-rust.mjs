// Type-checker truth for Rust: drives rust-analyzer over stdio and asks textDocument/definition for every call site
// enumerated by sites-rust.mjs, once the server reports that the workspace is loaded. A site is "in-repo" when
// rust-analyzer returns a definition inside the corpus, "external" when every definition is outside it (standard
// library sources, the cargo registry), and undecided when it returns nothing.
// usage: node truth-rust.mjs --root <checkout> --sites <sites.json> --sysroot-src <rust-src library dir>
//        --target-dir <dir outside the checkout> --output <truth.json> [--server rust-analyzer] [--corpus <id>]
//        [--concurrency 8]
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolveSites, startServer } from "./lsp.mjs";

const { values } = parseArgs({
  options: { root: { type: "string" }, sites: { type: "string" }, server: { type: "string", default: "rust-analyzer" },
             "sysroot-src": { type: "string" }, "target-dir": { type: "string" }, output: { type: "string" },
             corpus: { type: "string" }, concurrency: { type: "string", default: "8" } },
});
if (!values.root || !values.sites || !values.output || !values["target-dir"]) throw new Error("usage: truth-rust.mjs --root <checkout> --sites <sites.json> --target-dir <dir> --output <truth.json> [--sysroot-src <dir>]");
const root = path.resolve(values.root);
const input = JSON.parse(await fs.readFile(values.sites, "utf8"));
const targetDir = path.resolve(values["target-dir"]);
const server = startServer(values.server, [], { env: { ...process.env, CARGO_TARGET_DIR: targetDir } });

let resolveReady;
const ready = new Promise((resolve) => { resolveReady = resolve; });
server.onNotification("experimental/serverStatus", (status) => {
  if (status?.health !== "ok") console.error(JSON.stringify({ serverStatus: status }));
  if (status?.quiescent) resolveReady(status);
});

const initialized = await server.request("initialize", {
  processId: process.pid, rootUri: pathToFileURL(root).href,
  workspaceFolders: [{ uri: pathToFileURL(root).href, name: "corpus" }],
  capabilities: { textDocument: { definition: { linkSupport: true } }, experimental: { serverStatusNotification: true } },
  initializationOptions: {
    cargo: { targetDir, buildScripts: { enable: true }, ...(values["sysroot-src"] ? { sysrootSrc: path.resolve(values["sysroot-src"]) } : {}) },
    procMacro: { enable: true }, checkOnSave: false, cachePriming: { enable: false },
  },
});
server.notify("initialized", {});
const status = await ready;

const { entries, external, inRepoDecided, undecided } = await resolveSites(server, root, input.sites,
  { languageId: "rust", concurrency: Number(values.concurrency), readFile: (file) => fs.readFile(file, "utf8") });

server.kill();
await fs.writeFile(values.output, JSON.stringify({
  schemaVersion: 1, oracle: "rust-analyzer", oracleVersion: initialized?.result?.serverInfo?.version ?? null, corpus: values.corpus ?? null,
  method: "rust-analyzer over stdio, queried after it reports the workspace quiescent (build scripts and proc macros enabled, default features, host target); textDocument/definition at every call-site callee identifier enumerated from the tree-sitter Rust grammar (UTF-16 columns); in-repo when a definition lands inside the corpus, external when every definition is outside it, undecided when rust-analyzer returns none",
  serverHealth: status.health ?? null,
  stats: { sites: input.sites.length, files: input.files, inRepoDecided, external, undecided },
  entries,
}, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ oracle: "rust-analyzer", version: initialized?.result?.serverInfo?.version ?? null, sites: input.sites.length, inRepoDecided, external, undecided }));

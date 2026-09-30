// Type-checker truth for Python: drives pyright-langserver over stdio and asks textDocument/definition for every
// call site enumerated by sites-python.py. A site is "in-repo" when pyright returns a
// definition inside the corpus, "external" when every definition is outside it (stdlib,
// typeshed, site-packages), and undecided when pyright returns nothing.
// usage: node truth-python.mjs --root <checkout> --sites <sites.json> --server <pyright/langserver.index.js>
//        --output <truth.json> [--corpus <id>] [--concurrency 8]
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolveSites, startServer } from "./lsp.mjs";

const { values } = parseArgs({
  options: { root: { type: "string" }, sites: { type: "string" }, server: { type: "string" },
             output: { type: "string" }, corpus: { type: "string" }, concurrency: { type: "string", default: "8" } },
});
const root = path.resolve(values.root);
const input = JSON.parse(await fs.readFile(values.sites, "utf8"));
const concurrency = Number(values.concurrency);

// pyright does not report its version on initialize; its package.json sits beside the server script's folder.
const serverPackageVersion = () => {
  for (const dir of [path.dirname(values.server), path.dirname(path.dirname(values.server))]) {
    try { return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version ?? null; } catch { /* try the next folder */ }
  }
  return null;
};
const server = startServer(process.execPath, [values.server, "--stdio"]);

const initialized = await server.request("initialize", {
  processId: process.pid, rootUri: pathToFileURL(root).href,
  workspaceFolders: [{ uri: pathToFileURL(root).href, name: "corpus" }],
  capabilities: { textDocument: { definition: { linkSupport: true } } },
  initializationOptions: {},
});
server.notify("initialized", {});

const { entries, external, inRepoDecided, undecided } = await resolveSites(server, root, input.sites,
  { languageId: "python", concurrency, readFile: (file) => fs.readFile(file, "utf8") });

server.kill();
await fs.writeFile(values.output, JSON.stringify({
  schemaVersion: 1, oracle: "pyright", oracleVersion: initialized?.result?.serverInfo?.version ?? serverPackageVersion(), corpus: values.corpus ?? null,
  method: "pyright-langserver over stdio; textDocument/definition at every call-site callee identifier enumerated from the Python AST (UTF-16 columns); in-repo when a definition lands inside the corpus, external when every definition is outside it, undecided when pyright returns none",
  stats: { sites: input.sites.length, files: input.files, inRepoDecided, external, undecided },
  entries,
}, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ oracle: "pyright", sites: input.sites.length, inRepoDecided, external, undecided }));

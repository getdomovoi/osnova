// Type-checker truth for Python: drives pyright-langserver over stdio and asks textDocument/definition for every
// call site enumerated by sites-python.py. A site is "in-repo" when pyright returns a
// definition inside the corpus, "external" when every definition is outside it (stdlib,
// typeshed, site-packages), and undecided when pyright returns nothing.
// usage: node truth-python.mjs --root <checkout> --sites <sites.json> --server <pyright/langserver.index.js>
//        --output <truth.json> [--corpus <id>] [--concurrency 8]
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";

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
const child = spawn(process.execPath, [values.server, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
let buffer = Buffer.alloc(0);
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const header = buffer.indexOf("\r\n\r\n");
    if (header < 0) return;
    const match = /Content-Length: (\d+)/i.exec(buffer.slice(0, header).toString("ascii"));
    if (!match) return;
    const length = Number(match[1]);
    if (buffer.length < header + 4 + length) return;
    const body = buffer.slice(header + 4, header + 4 + length).toString("utf8");
    buffer = buffer.slice(header + 4 + length);
    let message; try { message = JSON.parse(body); } catch { continue; }
    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  }
});
child.stderr.on("data", () => {});

let nextId = 1;
const write = (object) => {
  const payload = Buffer.from(JSON.stringify(object), "utf8");
  child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
  child.stdin.write(payload);
};
const request = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  write({ jsonrpc: "2.0", id, method, params });
});
const notify = (method, params) => write({ jsonrpc: "2.0", method, params });

const initialized = await request("initialize", {
  processId: process.pid, rootUri: pathToFileURL(root).href,
  workspaceFolders: [{ uri: pathToFileURL(root).href, name: "corpus" }],
  capabilities: { textDocument: { definition: { linkSupport: true } } },
  initializationOptions: {},
});
notify("initialized", {});

const byFile = new Map();
for (const site of input.sites) {
  if (!byFile.has(site.file)) byFile.set(site.file, []);
  byFile.get(site.file).push(site);
}

const entries = [];
let external = 0, inRepoDecided = 0, undecided = 0;
const inRepo = (file) => file.startsWith(root + path.sep);

for (const [file, siteList] of byFile) {
  const absolute = path.join(root, file);
  const uri = pathToFileURL(absolute).href;
  const text = await fs.readFile(absolute, "utf8");
  notify("textDocument/didOpen", { textDocument: { uri, languageId: "python", version: 1, text } });
  for (let i = 0; i < siteList.length; i += concurrency) {
    const batch = siteList.slice(i, i + concurrency);
    const answers = await Promise.all(batch.map((site) =>
      request("textDocument/definition", { textDocument: { uri }, position: { line: site.line - 1, character: site.character } })));
    for (let j = 0; j < batch.length; j += 1) {
      const site = batch[j];
      const result = answers[j]?.result;
      const raw = result === null || result === undefined ? [] : (Array.isArray(result) ? result : [result]);
      const defs = raw.map((item) => {
        const target = item.targetUri ?? item.uri;
        const range = item.targetSelectionRange ?? item.targetRange ?? item.range;
        if (!target || !range) return null;
        let filePath; try { filePath = fileURLToPath(target); } catch { return null; }
        return { file: filePath, line: range.start.line + 1 };
      }).filter(Boolean);
      if (defs.length === 0) { undecided += 1; entries.push({ file, line: site.line, name: site.name, verdict: "undecided", defs: [] }); continue; }
      const local = defs.filter((d) => inRepo(d.file)).map((d) => ({ file: path.relative(root, d.file).split(path.sep).join("/"), line: d.line }));
      if (local.length === 0) { external += 1; entries.push({ file, line: site.line, name: site.name, verdict: "external", defs: [] }); }
      else { inRepoDecided += 1; entries.push({ file, line: site.line, name: site.name, verdict: "in-repo", defs: local }); }
    }
  }
  notify("textDocument/didClose", { textDocument: { uri } });
}

child.kill();
await fs.writeFile(values.output, JSON.stringify({
  schemaVersion: 1, oracle: "pyright", oracleVersion: initialized?.result?.serverInfo?.version ?? serverPackageVersion(), corpus: values.corpus ?? null,
  method: "pyright-langserver over stdio; textDocument/definition at every call-site callee identifier enumerated from the Python AST (UTF-16 columns); in-repo when a definition lands inside the corpus, external when every definition is outside it, undecided when pyright returns none",
  stats: { sites: input.sites.length, files: input.files, inRepoDecided, external, undecided },
  entries,
}, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ oracle: "pyright", sites: input.sites.length, inRepoDecided, external, undecided }));

// Minimal Language Server Protocol client over stdio, shared by the LSP-driven truth scripts.
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export function startServer(command, args, { env = process.env, cwd } = {}) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env, ...(cwd === undefined ? {} : { cwd }) });
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  const listeners = new Map();
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
      // A message with a method is a server notification or a server request; server requests go unanswered, and
      // their ids must not be taken for answers to the client's own requests.
      if (message.method !== undefined) { if (message.id === undefined) for (const listener of listeners.get(message.method) ?? []) listener(message.params); continue; }
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
  const onNotification = (method, listener) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(listener);
  };
  return { request, notify, onNotification, kill: () => child.kill() };
}

// Answers a textDocument/definition result as absolute file paths and 1-based lines of the definition names.
export function definitionTargets(result) {
  const raw = result === null || result === undefined ? [] : (Array.isArray(result) ? result : [result]);
  return raw.map((item) => {
    const target = item.targetUri ?? item.uri;
    const range = item.targetSelectionRange ?? item.targetRange ?? item.range;
    if (!target || !range) return null;
    let filePath; try { filePath = fileURLToPath(target); } catch { return null; }
    return { file: filePath, line: range.start.line + 1 };
  }).filter(Boolean);
}

// Asks for the definition at every site, one file at a time, and classifies each answer as in-repo, external or
// undecided. `languageId` is sent with didOpen.
export async function resolveSites(server, root, sites, { languageId, concurrency, readFile }) {
  const byFile = new Map();
  for (const site of sites) {
    if (!byFile.has(site.file)) byFile.set(site.file, []);
    byFile.get(site.file).push(site);
  }
  const entries = [];
  let external = 0, inRepoDecided = 0, undecided = 0;
  const inRepo = (file) => file.startsWith(root + path.sep);
  for (const [file, siteList] of byFile) {
    const absolute = path.join(root, file);
    const uri = pathToFileURL(absolute).href;
    const text = await readFile(absolute);
    server.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
    for (let i = 0; i < siteList.length; i += concurrency) {
      const batch = siteList.slice(i, i + concurrency);
      const answers = await Promise.all(batch.map((site) =>
        server.request("textDocument/definition", { textDocument: { uri }, position: { line: site.line - 1, character: site.character } })));
      for (let j = 0; j < batch.length; j += 1) {
        const site = batch[j];
        const defs = definitionTargets(answers[j]?.result);
        if (defs.length === 0) { undecided += 1; entries.push({ file, line: site.line, name: site.name, verdict: "undecided", defs: [] }); continue; }
        const local = defs.filter((d) => inRepo(d.file)).map((d) => ({ file: path.relative(root, d.file).split(path.sep).join("/"), line: d.line }));
        if (local.length === 0) { external += 1; entries.push({ file, line: site.line, name: site.name, verdict: "external", defs: [] }); }
        else { inRepoDecided += 1; entries.push({ file, line: site.line, name: site.name, verdict: "in-repo", defs: local }); }
      }
    }
    server.notify("textDocument/didClose", { textDocument: { uri } });
  }
  return { entries, external, inRepoDecided, undecided };
}

import fs from "node:fs";

const [mode = "normal", log, expectedLanguage] = process.argv.slice(2);
let buffer = Buffer.alloc(0);
let initialized = false;
let ready = false;
let shutdown = false;
const opened = new Map();
const events = [];

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  if (mode === "fragment") {
    for (let i = 0; i < frame.length; i += 3) process.stdout.write(frame.subarray(i, i + 3));
  } else process.stdout.write(frame);
}

function receive(message) {
  events.push(message.method ?? "response");
  if (log) { fs.writeFileSync(`${log}.tmp`, JSON.stringify(events)); fs.renameSync(`${log}.tmp`, log); }
  const { id, method, params } = message;
  if (method === "initialize") {
    if (!params.rootUri.startsWith("file:") || params.capabilities.general.positionEncodings[0] !== "utf-16") process.exit(2);
    initialized = true;
    send({ id, result: { capabilities: { referencesProvider: mode !== "unsupported", definitionProvider: true, positionEncoding: mode === "encoding" ? "utf-8" : "utf-16" } } });
  } else if (method === "initialized") {
    if (!initialized) process.exit(3);
    ready = true;
  } else if (method === "textDocument/didOpen") {
    if (!ready || !params.textDocument.text.includes("target")) process.exit(4);
    if (expectedLanguage && params.textDocument.languageId !== expectedLanguage) process.exit(8);
    opened.set(params.textDocument.uri, params.textDocument);
  } else if (method === "textDocument/references" || method === "textDocument/definition") {
    if (!ready || !opened.has(params.textDocument.uri)) process.exit(5);
    if (mode === "timeout") return;
    if (mode === "error" && params.position.character === 0) return send({ id, error: { code: -32603, message: "fixture failure" } });
    if (mode === "malformed") return process.stdout.write("Content-Length: nope\r\n\r\n{}");
    if (mode === "oversized") return process.stdout.write("Content-Length: 999999999\r\n\r\n");
    if (mode === "json") return process.stdout.write("Content-Length: 1\r\n\r\n{");
    if (mode === "exit") return process.exit(6);
    if (mode === "server-request") send({ id: "edit", method: "workspace/applyEdit", params: { edit: {} } });
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } };
    if (mode === "partial") {
      if (fs.existsSync(`${log}.fail`)) return send({ id, error: { code: -32603, message: "fixture failure" } });
      return send({ id, result: [{ uri: params.textDocument.uri, range }, { uri: "file:///outside", range }] });
    }
    if (mode === "link") return send({ id, result: [{ targetUri: params.textDocument.uri, targetRange: range, targetSelectionRange: range }] });
    if (mode === "duplicate-header") return process.stdout.write("Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}");
    if (mode === "long-header") return process.stdout.write("x".repeat(9000));
    if (mode === "stderr") return process.stderr.write("x".repeat(10000));
    if (mode === "mutate") fs.writeFileSync(new URL(params.textDocument.uri), "target edited by fixture");
    send({ id, result: mode === "bad-location" ? [{ uri: "file:///outside", range }] : [{ uri: params.textDocument.uri, range }] });
  } else if (method === "test/events") {
    send({ id, result: { events, languages: [...opened.values()].map((doc) => doc.languageId), text: "target caf\u00e9" } });
  } else if (method === "shutdown") {
    if (mode === "hang-shutdown") return;
    shutdown = true;
    send({ id, result: null });
  } else if (method === "exit") {
    process.exit(shutdown ? 0 : 7);
  } else if (id !== undefined && method) {
    send({ id, error: { code: -32601, message: "unknown method" } });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + size) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString());
    buffer = buffer.subarray(end + 4 + size);
    receive(message);
  }
});

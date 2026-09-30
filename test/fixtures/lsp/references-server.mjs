// A minimal language server for tests: it answers textDocument/references with the locations listed in a JSON file
// and appends one line to a log for every launch ("launch <pid>") and every opened file ("open <file>").
// usage: node references-server.mjs <responses.json> <launch.log>
// responses.json: { "delayMs"?: number, "initDelayMs"?: number, "ignoreShutdown"?: boolean, "exitOnReferences"?: boolean, "grow"?: boolean, "locations": [{ "file", "line", "character" }] }
// With grow, the n-th request gets only the first n locations, as a server still loading its projects would answer.
// (file relative to the workspace, line and character zero-based)
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [responsesFile, launchLog] = process.argv.slice(2);
appendFileSync(launchLog, `launch ${process.pid}\n`);
let root = "";
let requests = 0;
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}

function handle(message) {
  if (message.method === "initialize") {
    root = fileURLToPath(message.params.rootUri);
    const { initDelayMs } = JSON.parse(readFileSync(responsesFile, "utf8"));
    setTimeout(() => send({ id: message.id, result: { capabilities: { referencesProvider: true } } }), initDelayMs ?? 0);
  } else if (message.method === "textDocument/didOpen") {
    appendFileSync(launchLog, `open ${path.relative(root, fileURLToPath(message.params.textDocument.uri)).split(path.sep).join("/")}\n`);
  } else if (message.method === "textDocument/references") {
    const responses = JSON.parse(readFileSync(responsesFile, "utf8"));
    if (responses.exitOnReferences) process.exit(1);
    requests += 1;
    const listed = responses.grow ? responses.locations.slice(0, requests) : responses.locations;
    const result = listed.map((l) => ({ uri: pathToFileURL(path.join(root, l.file)).href, range: { start: { line: l.line, character: l.character }, end: { line: l.line, character: l.character + 1 } } }));
    setTimeout(() => send({ id: message.id, result }), responses.delayMs ?? 0);
  } else if (message.method === "shutdown") {
    if (!JSON.parse(readFileSync(responsesFile, "utf8")).ignoreShutdown) send({ id: message.id, result: null });
  } else if (message.method === "exit") {
    if (!JSON.parse(readFileSync(responsesFile, "utf8")).ignoreShutdown) process.exit(0);
  } else if (message.id !== undefined) {
    send({ id: message.id, result: null });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(/content-length: *(\d+)/i.exec(buffer.subarray(0, end).toString("ascii"))[1]);
    if (buffer.length < end + 4 + length) return;
    const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
    buffer = buffer.subarray(end + 4 + length);
    handle(JSON.parse(body));
  }
});

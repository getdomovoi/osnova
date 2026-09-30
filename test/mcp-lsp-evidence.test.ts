import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { createOsnovaMcpServer, type OsnovaMcpOptions } from "../src/mcp/server.js";

const serverScript = path.join(import.meta.dirname, "fixtures/lsp/references-server.mjs");
const temporaries: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of temporaries.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

interface Fixture { workspace: string; cacheDir: string; responses: string; launches: string }
type Place = { file: string; line: number; character: number };

async function fixture(): Promise<Fixture> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-lsp-evidence-"));
  temporaries.push(dir);
  const workspace = path.join(dir, "ws");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "lib.ts"), "export function helper(): number { return 1; }\n");
  // Line 2 is a call the syntax graph resolves; line 3 calls through a receiver it cannot type, so it stays unresolved.
  await fs.writeFile(path.join(workspace, "use.ts"), [
    "import { helper } from \"./lib\";",
    "export function direct(): number { return helper(); }",
    "export function viaAny(x: any): number { return x.helper(); }",
    "",
  ].join("\n"));
  const f = { workspace, cacheDir: path.join(dir, "cache"), responses: path.join(dir, "responses.json"), launches: path.join(dir, "launches.log") };
  await fs.writeFile(f.launches, "");
  await respond(f, [
    { file: "lib.ts", line: 0, character: 16 },
    { file: "use.ts", line: 0, character: 9 },
    { file: "use.ts", line: 1, character: 42 },
    { file: "use.ts", line: 2, character: 50 },
  ]);
  return f;
}

async function respond(f: Fixture, locations: Place[], extra: Record<string, unknown> = {}): Promise<void> {
  await fs.writeFile(f.responses, JSON.stringify({ locations, ...extra }));
}

async function logged(f: Fixture, prefix: string): Promise<string[]> {
  return (await fs.readFile(f.launches, "utf8")).split("\n").filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length));
}

async function connect(f: Fixture, withLsp = true, requestTimeoutMs?: number): Promise<Client> {
  const options: OsnovaMcpOptions = {
    cacheDir: f.cacheDir,
    ...(withLsp ? { lsp: { executable: process.execPath, args: [serverScript, f.responses, f.launches], languages: ["typescript"], ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}) } } : {}),
  };
  const { server, close } = createOsnovaMcpServer(f.workspace, options);
  closers.push(close);
  const client = new Client({ name: "osnova-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result)).toBeFalsy();
  return ((result as { content?: readonly ContentBlock[] }).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
}

// The graph answer before the section, and the section itself.
function split(text: string): { graph: string; section: string } {
  const at = text.indexOf("\nlanguage server (");
  return at < 0 ? { graph: text, section: "" } : { graph: text.slice(0, at), section: text.slice(at + 1) };
}

it("plumb: marks claims the server confirms and lists sites the claim left out, after unchanged graph verdicts", async () => {
  const f = await fixture();
  const args = { symbol: "lib.ts#helper", sites: ["use.ts:2", "use.ts:3"] };
  const without = await call(await connect(f, false), "osnova_plumb", args);
  const { graph, section } = split(await call(await connect(f), "osnova_plumb", args));
  expect(graph).toBe(without);
  expect(graph).toContain("name-only use.ts:3");
  expect(section).toContain("language server (textDocument/references, not syntax edges): 4 locations: declaration 1, on claimed sites 2, on missing sites above 0, elsewhere 1; the server confirms 2 of 2 claims (graph confirmed 1, name-only 1, no-call 0, not-indexed 0)");
  expect(section).toMatch(/claims the server confirms and the graph does not \(1 line\):\n\s+use\.ts:3 name-only in viaAny/);
  expect(section).toMatch(/left out of the claim and not missing above \(1 line\):\n\s+use\.ts:1 \(top level\)/);
});

it("plumb: lists a left-out unresolved lead and counts a site the graph already lists as missing", async () => {
  const f = await fixture();
  const leftOut = split(await call(await connect(f), "osnova_plumb", { symbol: "lib.ts#helper", sites: ["use.ts:2"] })).section;
  expect(leftOut).toContain("4 locations: declaration 1, on claimed sites 1, on missing sites above 0, elsewhere 2; the server confirms 1 of 1 claims (graph confirmed 1, name-only 0, no-call 0, not-indexed 0)");
  expect(leftOut).toMatch(/use\.ts:3 in viaAny \(graph: name-only\)/);
  const missing = split(await call(await connect(f), "osnova_plumb", { symbol: "lib.ts#helper", sites: ["use.ts:3", "lib.ts:1"] })).section;
  expect(missing).toContain("4 locations: declaration 1, on claimed sites 1, on missing sites above 1, elsewhere 1; the server confirms 1 of 2 claims (graph confirmed 0, name-only 1, no-call 0, not-indexed 0)");
  expect(missing).not.toMatch(/use\.ts:2\b/);
});

it("plumb: adds nothing for a callees claim or without a server", async () => {
  const f = await fixture();
  expect(await call(await connect(f, false), "osnova_plumb", { symbol: "lib.ts#helper", sites: ["use.ts:2"] })).not.toContain("language server");
  expect(await call(await connect(f), "osnova_plumb", { symbol: "use.ts#direct", sites: ["use.ts:2"], direction: "out" })).not.toContain("language server");
  expect(await logged(f, "launch ")).toEqual([]);
});

it("plumb: keeps the graph verdicts when the server times out", async () => {
  const f = await fixture();
  await respond(f, [], { delayMs: 5_000 });
  const started = Date.now();
  const text = await call(await connect(f, true, 300), "osnova_plumb", { symbol: "lib.ts#helper", sites: ["use.ts:2"] });
  expect(Date.now() - started).toBeLessThan(4_000);
  expect(text).toContain("confirmed use.ts:2");
  expect(text).toMatch(/\nlanguage server \(textDocument\/references\): unavailable \([a-z0-9-]+\)$/);
});

it("plumb: bounds the section with an exact count of the lines it leaves out", async () => {
  const f = await fixture();
  const calls = Array.from({ length: 300 }, (_, i) => `export function caller${i}(x: any): number { return x.helper(); }`);
  await fs.writeFile(path.join(f.workspace, "many.ts"), `${calls.join("\n")}\n`);
  await respond(f, calls.map((_, i) => ({ file: "many.ts", line: i, character: 50 })));
  const { section } = split(await call(await connect(f), "osnova_plumb", { symbol: "lib.ts#helper", sites: ["use.ts:2"] }));
  expect(section).toContain("300 locations: declaration 0, on claimed sites 0, on missing sites above 0, elsewhere 300");
  const shown = (section.match(/many\.ts:\d+ in caller\d+/g) ?? []).length;
  expect(shown).toBeGreaterThan(0);
  expect(section).toContain(`+${300 - shown} more lines not shown`);
  expect(section.length).toBeLessThanOrEqual(1_024);
});

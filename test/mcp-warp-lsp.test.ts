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
const closers: (() => void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const dir of temporaries.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

interface Fixture { workspace: string; cacheDir: string; responses: string; launches: string }

async function fixture(): Promise<Fixture> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-warp-lsp-"));
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

async function respond(f: Fixture, locations: { file: string; line: number; character: number }[], extra: Record<string, unknown> = {}): Promise<void> {
  await fs.writeFile(f.responses, JSON.stringify({ locations, ...extra }));
}

async function launches(f: Fixture): Promise<number> {
  return (await fs.readFile(f.launches, "utf8")).split("\n").filter((line) => line === "launch").length;
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

async function warp(client: Client, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name: "osnova_warp", arguments: args });
  expect(result.isError, JSON.stringify(result)).toBeFalsy();
  return ((result as { content?: readonly ContentBlock[] }).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
}

it("sorts the server's references against the graph answer, in their own labelled section", async () => {
  const f = await fixture();
  const text = await warp(await connect(f), { symbol: "lib.ts#helper" });
  const at = text.indexOf("\nlanguage server (");
  expect(at).toBeGreaterThan(0);
  expect(text.slice(0, at)).toContain("d1 calls use.ts#direct:2");
  const section = text.slice(at);
  expect(section).toContain("(textDocument/references, not syntax edges): 4 locations: declaration 1, resolved above 1, confirmed unresolved leads 1, not in the graph 1");
  expect(section).toMatch(/confirmed unresolved leads \(1 line\):\n\s+use\.ts:3 in viaAny/);
  expect(section).toMatch(/not in the graph \(1 line\):\n\s+use\.ts:1 \(top level\)/);
  expect(section).not.toContain("lib.ts:1");
  expect(section).not.toMatch(/use\.ts:2\b/);
});

it("keeps one server session until the sources change", async () => {
  const f = await fixture();
  const client = await connect(f);
  await warp(client, { symbol: "lib.ts#helper" });
  await warp(client, { symbol: "lib.ts#helper" });
  expect(await launches(f)).toBe(1);
  await fs.appendFile(path.join(f.workspace, "use.ts"), "export const later = 1;\n");
  await warp(client, { symbol: "lib.ts#helper" });
  expect(await launches(f)).toBe(2);
});

it("still answers from the graph when the server fails", async () => {
  const f = await fixture();
  await respond(f, [], { exitOnReferences: true });
  const text = await warp(await connect(f), { symbol: "lib.ts#helper" });
  expect(text).toContain("d1 calls use.ts#direct:2");
  expect(text).toMatch(/\nlanguage server \(textDocument\/references\): unavailable \([a-z0-9-]+\)$/);
});

it("launches nothing without the option, and only for the callers direction", async () => {
  const f = await fixture();
  expect(await warp(await connect(f, false), { symbol: "lib.ts#helper" })).not.toContain("language server");
  expect(await warp(await connect(f), { symbol: "use.ts#direct", direction: "out" })).not.toContain("language server");
  expect(await launches(f)).toBe(0);
});

it("bounds the section with exact counts of what it left out", async () => {
  const f = await fixture();
  const calls = Array.from({ length: 300 }, (_, i) => `export function caller${i}(x: any): number { return x.helper(); }`);
  await fs.writeFile(path.join(f.workspace, "many.ts"), `${calls.join("\n")}\n`);
  await respond(f, calls.map((_, i) => ({ file: "many.ts", line: i, character: 50 })));
  const text = await warp(await connect(f), { symbol: "lib.ts#helper" });
  const section = text.slice(text.indexOf("\nlanguage server ("));
  expect(section).toContain("300 locations: declaration 0, resolved above 0, confirmed unresolved leads 300, not in the graph 0");
  const shown = (section.match(/many\.ts:\d+ in caller\d+/g) ?? []).length;
  expect(shown).toBeGreaterThan(0);
  expect(section).toContain(`+${300 - shown} more lines not shown`);
  expect(section.length).toBeLessThanOrEqual(1_024);
});

it("gives a new session every indexed file in its languages, so references reach other projects", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.workspace, "notes.py"), "def other():\n    return 1\n");
  await warp(await connect(f), { symbol: "lib.ts#helper" });
  const opened = (await fs.readFile(f.launches, "utf8")).split("\n").filter((line) => line.startsWith("open ")).map((line) => line.slice(5)).sort();
  expect(opened).toEqual(["lib.ts", "use.ts"]);
});

it("says when the server was given only part of the files", async () => {
  const { formatLspReferences } = await import("../src/mcp/lsp-section.js");
  const target = { name: "helper", qualifiedName: "lib.ts#helper", file: "lib.ts", kind: "function", span: { startLine: 1, endLine: 1 } } as unknown as Parameters<typeof formatLspReferences>[1]["target"];
  const index = { files: new Map() } as unknown as Parameters<typeof formatLspReferences>[0];
  const found = { status: "found", scope: "indexed-graph", direction: "in", depth: 1, target, hits: [], unresolved: [] } as Parameters<typeof formatLspReferences>[1];
  const text = formatLspReferences(index, found, { status: "complete", locations: [], queried: { line: 0, character: 16 }, filesGiven: 4_096, filesEligible: 5_000, loading: false });
  expect(text).toContain("0 locations: declaration 0, resolved above 0, confirmed unresolved leads 0, not in the graph 0 (the server was given 4096 of 5000 files)");
});

it("waits for a server that is still loading to give the same answer twice", async () => {
  const f = await fixture();
  const locations = JSON.parse(await fs.readFile(f.responses, "utf8")).locations;
  await respond(f, locations, { grow: true });
  const text = await warp(await connect(f), { symbol: "lib.ts#helper" });
  expect(text).toContain("4 locations: declaration 1, resolved above 1, confirmed unresolved leads 1, not in the graph 1");
});

it("counts overload signatures of the target as declarations", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.workspace, "lib.ts"), [
    "export function helper(a: string): number;",
    "export function helper(a: number): number;",
    "export function helper(a: unknown): number { return 1; }",
    "",
  ].join("\n"));
  await respond(f, [
    { file: "lib.ts", line: 0, character: 16 },
    { file: "lib.ts", line: 1, character: 16 },
    { file: "lib.ts", line: 2, character: 16 },
    { file: "use.ts", line: 2, character: 50 },
  ]);
  const text = await warp(await connect(f), { symbol: "lib.ts#helper" });
  expect(text).toContain("4 locations: declaration 3,");
  expect(text).toContain("not in the graph 0");
});

it("says so when the server's answer never settles", async () => {
  const f = await fixture();
  await respond(f, Array.from({ length: 60 }, (_, i) => ({ file: "use.ts", line: 2, character: i })), { grow: true });
  const text = await warp(await connect(f, true, 600), { symbol: "lib.ts#helper" });
  expect(text).toContain("the server was still loading its projects, so its list may be incomplete");
});

it("counts every call on a line the graph already resolved", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.workspace, "twice.ts"), "import { helper } from \"./lib\";\nexport function twice(): number { return helper() + helper(); }\n");
  await respond(f, [
    { file: "lib.ts", line: 0, character: 16 },
    { file: "twice.ts", line: 1, character: 41 },
    { file: "twice.ts", line: 1, character: 52 },
  ]);
  const text = await warp(await connect(f), { symbol: "lib.ts#helper" });
  expect(text).toContain("3 locations: declaration 1, resolved above 2, confirmed unresolved leads 0, not in the graph 0");
});

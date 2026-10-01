import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { createOsnovaMcpServer, type OsnovaMcpOptions } from "../src/mcp/server.js";
import { LspReferenceSession } from "../src/enrichment/session.js";
import { buildIndex, indexGeneration } from "../src/index.js";

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

it("plumb: confirms a claim only from a location on the claimed line, and lists a neighbouring one where the server put it", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.workspace, "use.ts"), "import { helper } from \"./lib\";\nexport const value = 42;\n");
  await respond(f, [{ file: "use.ts", line: 0, character: 9 }]);
  const args = { symbol: "lib.ts#helper", sites: ["use.ts:2"] };
  const without = await call(await connect(f, false), "osnova_plumb", args);
  const { graph, section } = split(await call(await connect(f), "osnova_plumb", args));
  expect(graph).toBe(without);
  expect(graph).toMatch(/no-call[^\n]*use\.ts:2/);
  expect(section).toContain("1 locations: declaration 0, on claimed sites 0, on missing sites above 0, elsewhere 1; the server confirms 0 of 1 claims (graph confirmed 0, name-only 0, no-call 0, not-indexed 0)");
  expect(section).toMatch(/left out of the claim and not missing above \(1 line\):\n\s+use\.ts:1 \(top level\)$/);
  expect(section).not.toMatch(/use\.ts:2\b/);
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

// A diff that rewrites the given one-based lines of a file in place, so settle attributes them to the symbols there.
async function rewrite(f: Fixture, file: string, lines: readonly number[]): Promise<string> {
  const text = (await fs.readFile(path.join(f.workspace, file), "utf8")).split("\n");
  return [`--- a/${file}`, `+++ b/${file}`, ...lines.flatMap((line) => [`@@ -${line},1 +${line},1 @@`, `-${text[line - 1]} `, `+${text[line - 1]}`]), ""].join("\n");
}

async function settleFixture(): Promise<Fixture> {
  const f = await fixture();
  await fs.writeFile(path.join(f.workspace, "lib.ts"), "export function helper(): number { return 1; }\nexport function other(): number { return helper(); }\n");
  await respond(f, [], { byPosition: { "lib.ts:0": [
    { file: "lib.ts", line: 0, character: 16 },
    { file: "lib.ts", line: 1, character: 42 },
    { file: "use.ts", line: 0, character: 9 },
    { file: "use.ts", line: 1, character: 42 },
    { file: "use.ts", line: 2, character: 50 },
  ] } });
  return f;
}

it("settle: lists server references not among the graph dependents, after the unchanged impact answer", async () => {
  const f = await settleFixture();
  const args = { diff: await rewrite(f, "lib.ts", [1]) };
  const without = await call(await connect(f, false), "osnova_settle", args);
  const { graph, section } = split(await call(await connect(f), "osnova_settle", args));
  expect(graph).toBe(without);
  expect(graph).toContain("current d1 use.ts#direct");
  expect(section).toContain("language server (textDocument/references, not syntax edges): asked about 1 of 1 changed symbols in its languages (not asked: 0 over the cap of 8, 0 past the deadline, 0 after a failure); 5 locations: declaration 1, inside changed symbols 0, among the dependents above 2, not among them 2");
  expect(section).toMatch(/ lib\.ts#helper: not among the dependents \(2 lines\):\n\s+use\.ts:1 \(top level\)\n\s+use\.ts:3 in viaAny/);
});

it("settle: asks about at most 8 symbols, most depended-on first, and counts the rest", async () => {
  const f = await settleFixture();
  await fs.writeFile(path.join(f.workspace, "cap.ts"), `${Array.from({ length: 10 }, (_, i) => `export function f${i}(): number { return ${i}; }`).join("\n")}\n`);
  await fs.writeFile(path.join(f.workspace, "caller.ts"), "import { f9 } from \"./cap\";\nexport function g(): number { return f9(); }\n");
  const { section } = split(await call(await connect(f), "osnova_settle", { diff: await rewrite(f, "cap.ts", Array.from({ length: 10 }, (_, i) => i + 1)) }));
  expect(section).toContain("asked about 8 of 10 changed symbols in its languages (not asked: 2 over the cap of 8, 0 past the deadline, 0 after a failure)");
  expect([...new Set(await logged(f, "references "))].sort()).toEqual(["cap.ts:0", "cap.ts:1", "cap.ts:2", "cap.ts:3", "cap.ts:4", "cap.ts:5", "cap.ts:6", "cap.ts:9"]);
});

it("settle: stops asking at one deadline for the whole call", async () => {
  const f = await settleFixture();
  const diff = await rewrite(f, "lib.ts", [1, 2]) + await rewrite(f, "use.ts", [2]);
  const client = await connect(f, true, 1_000);
  // Start the server and build the index first, so a slow start on a busy machine does not use up the timed call's deadline.
  await respond(f, [{ file: "use.ts", line: 2, character: 50 }]);
  await call(client, "osnova_settle", { diff });
  await respond(f, [{ file: "use.ts", line: 2, character: 50 }], { delayMs: 700 });
  const started = Date.now();
  const { section } = split(await call(client, "osnova_settle", { diff }));
  expect(Date.now() - started).toBeLessThan(2_500);
  expect(section).toContain("asked about 1 of 3 changed symbols in its languages (not asked: 0 over the cap of 8, 2 past the deadline, 0 after a failure)");
});

it("settle and tests: one deadline bounds the wait behind earlier requests, and a symbol never sent counts as not asked", async () => {
  const f = await fixture();
  const index = await buildIndex(f.workspace, { cacheDir: f.cacheDir });
  const generation = indexGeneration(index);
  const helper = index.symbols.get("lib.ts#helper")!;
  const direct = index.symbols.get("use.ts#direct")!;
  const session = new LspReferenceSession(f.workspace, { executable: process.execPath, args: [serverScript, f.responses, f.launches], languages: ["typescript"], requestTimeoutMs: 500 }, f.cacheDir);
  closers.push(() => session.close());
  expect((await session.references(index, generation, helper)).status).toBe("complete");
  await respond(f, [{ file: "use.ts", line: 1, character: 42 }], { delayMs: 400 });
  const earlier = [session.references(index, generation, helper), session.references(index, generation, helper), session.references(index, generation, helper)];
  const started = Date.now();
  const asked = await session.referencesEach(index, generation, [direct]);
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(asked).toEqual({ answers: [], overCap: 0, pastDeadline: 1, afterFailure: 0 });
  // The requests ahead of it, and the one after it, are answered by the same server; the skipped one was never sent.
  expect((await Promise.all(earlier)).map((answer) => answer.status)).toEqual(["complete", "complete", "complete"]);
  expect((await session.references(index, generation, helper)).status).toBe("complete");
  expect(await logged(f, "launch ")).toHaveLength(1);
  expect(await logged(f, "references ")).not.toContain("use.ts:1");
});

it("settle: stops asking after a server failure and keeps the impact answer", async () => {
  const f = await settleFixture();
  await respond(f, [], { exitOnReferences: true });
  const text = await call(await connect(f), "osnova_settle", { diff: await rewrite(f, "lib.ts", [1, 2]) });
  expect(text).toContain("current d1 use.ts#direct");
  const { section } = split(text);
  expect(section).toContain("asked about 1 of 2 changed symbols in its languages (not asked: 0 over the cap of 8, 0 past the deadline, 1 after a failure); 1 unavailable; 0 locations");
  expect(section).toMatch(/unavailable \(1 line\):\n\s+lib\.ts#helper \([a-z0-9-]+\)/);
});

it("settle: bounds the section with an exact count of the lines it leaves out", async () => {
  const f = await settleFixture();
  const calls = Array.from({ length: 300 }, (_, i) => `export function caller${i}(x: any): number { return x.helper(); }`);
  await fs.writeFile(path.join(f.workspace, "many.ts"), `${calls.join("\n")}\n`);
  await respond(f, [], { byPosition: { "lib.ts:0": calls.map((_, i) => ({ file: "many.ts", line: i, character: 50 })) } });
  const { section } = split(await call(await connect(f), "osnova_settle", { diff: await rewrite(f, "lib.ts", [1]) }));
  expect(section).toContain("300 locations: declaration 0, inside changed symbols 0, among the dependents above 0, not among them 300");
  const shown = (section.match(/many\.ts:\d+ in caller\d+/g) ?? []).length;
  expect(shown).toBeGreaterThan(0);
  expect(section).toContain(`+${300 - shown} more lines not shown`);
  expect(section.length).toBeLessThanOrEqual(1_024);
});

async function testsFixture(): Promise<Fixture> {
  const f = await fixture();
  await fs.mkdir(path.join(f.workspace, "test"));
  // A test the graph resolves, one that only imports the file, and one the graph cannot tie to lib.ts at all.
  await fs.writeFile(path.join(f.workspace, "test/helper.test.ts"), "import { helper } from \"../lib\";\nexport function checks(): number { return helper(); }\n");
  await fs.writeFile(path.join(f.workspace, "lib.ts"), "export function helper(): number { return 1; }\nexport function other(): number { return 2; }\n");
  await fs.writeFile(path.join(f.workspace, "test/imports.test.ts"), "import { other } from \"../lib\";\nexport function checks(x: any): number { return other() + x.helper(); }\n");
  await fs.writeFile(path.join(f.workspace, "test/any.spec.ts"), "export function run(x: any): number { return x.helper(); }\n");
  await respond(f, [
    { file: "lib.ts", line: 0, character: 16 },
    { file: "use.ts", line: 1, character: 42 },
    { file: "test/helper.test.ts", line: 1, character: 42 },
    { file: "test/imports.test.ts", line: 1, character: 62 },
    { file: "test/any.spec.ts", line: 0, character: 47 },
  ]);
  return f;
}

it("tests: adds test files only the server finds as a third, separately labelled tier after the unchanged tiers", async () => {
  const f = await testsFixture();
  const args = { symbols: ["lib.ts#helper"] };
  const without = await call(await connect(f, false), "osnova_tests", args);
  const { graph, section } = split(await call(await connect(f), "osnova_tests", args));
  expect(graph).toBe(without);
  expect(graph).toContain("- test/helper.test.ts (resolved edge)");
  expect(graph).toContain("- test/imports.test.ts (imports the file only)");
  expect(graph).not.toContain("any.spec.ts");
  expect(section).toContain("language server (textDocument/references, not syntax edges): asked about 1 of 1 symbols in its languages (not asked: 0 over the cap of 8, 0 past the deadline, 0 after a failure); 5 locations: declaration 1, outside test files 1, in resolved-edge test files above 1, in import-only test files above 1, in other test files 1");
  expect(section).toMatch(/ lib\.ts#helper: test files neither tier lists, by the language server \(1 file\):\n\s+test\/any\.spec\.ts:1$/);
});

it("tests: counts a file the graph tier holds but its limit did not show as held, and adds nothing in file mode", async () => {
  const f = await testsFixture();
  const { graph, section } = split(await call(await connect(f), "osnova_tests", { symbols: ["lib.ts#helper"], limit: 1 }));
  expect(graph).not.toContain("imports.test.ts");
  expect(section).toContain("in resolved-edge test files above 1, in import-only test files above 1, in other test files 1");
  expect(await call(await connect(f), "osnova_tests", { file: "test/helper.test.ts" })).not.toContain("language server");
});

it("tests: stops asking at one deadline for the whole call", async () => {
  const f = await testsFixture();
  const client = await connect(f, true, 1_000);
  const symbols = ["lib.ts#helper", "use.ts#direct", "use.ts#viaAny"];
  // Start the server and build the index first, so a slow start on a busy machine does not use up the timed call's deadline.
  await respond(f, [{ file: "test/any.spec.ts", line: 0, character: 47 }]);
  await call(client, "osnova_tests", { symbols });
  await respond(f, [{ file: "test/any.spec.ts", line: 0, character: 47 }], { delayMs: 700 });
  const started = Date.now();
  const { section } = split(await call(client, "osnova_tests", { symbols }));
  expect(Date.now() - started).toBeLessThan(2_500);
  expect(section).toContain("asked about 1 of 3 symbols in its languages (not asked: 0 over the cap of 8, 2 past the deadline, 0 after a failure)");
});

it("tests: bounds the section with an exact count of the lines it leaves out", async () => {
  const f = await testsFixture();
  const files = Array.from({ length: 80 }, (_, i) => `test/case${i}.spec.ts`);
  for (const file of files) await fs.writeFile(path.join(f.workspace, file), "export function run(x: any): number { return x.helper(); }\n");
  await respond(f, files.map((file) => ({ file, line: 0, character: 47 })));
  const { section } = split(await call(await connect(f), "osnova_tests", { symbols: ["lib.ts#helper"] }));
  expect(section).toContain("80 locations: declaration 0, outside test files 0, in resolved-edge test files above 0, in import-only test files above 0, in other test files 80");
  const shown = (section.match(/test\/case\d+\.spec\.ts:1/g) ?? []).length;
  expect(shown).toBeGreaterThan(0);
  expect(section).toContain(`+${80 - shown} more lines not shown`);
  expect(section.length).toBeLessThanOrEqual(1_024);
});

it("settle: counts a reference on a line the graph attributes to a listed dependent as among them", async () => {
  const f = await settleFixture();
  // The graph attributes both module-level calls to the file, and lists the file once, by its first edge.
  await fs.writeFile(path.join(f.workspace, "consts.ts"), "import { helper } from \"./lib\";\nexport const a = helper();\nexport const b = helper();\n");
  await respond(f, [], { byPosition: { "lib.ts:0": [
    { file: "lib.ts", line: 0, character: 16 },
    { file: "consts.ts", line: 1, character: 17 },
    { file: "consts.ts", line: 2, character: 17 },
  ] } });
  const text = await call(await connect(f), "osnova_settle", { diff: await rewrite(f, "lib.ts", [1]) });
  expect(text).toContain("current d1 consts.ts ");
  expect(split(text).section).toContain("3 locations: declaration 1, inside changed symbols 0, among the dependents above 2, not among them 0");
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";
import * as loader from "../src/grammar/loader.js";
import { workspaceDirFor } from "../src/cache/cache.js";

let temporary: string;
let workspace: string;
let cacheDir: string;
let client: Client;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-health-mcp-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "one.ts"), "export function one() { return 1; }\n");
  const { server } = createOsnovaMcpServer(workspace, { cacheDir });
  closeServer = () => server.close();
  client = new Client({ name: "health-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await client.close();
  await closeServer();
  await fs.rm(temporary, { recursive: true, force: true });
});

it("all ten tools disclose partial foundation", async () => {
  await fs.writeFile(path.join(workspace, "broken.ts"), "export function broken( {");
  const tools: Array<[string, Record<string, unknown>]> = [
    ["osnova_ground", { question: "one" }], ["osnova_thread", { pattern: "one" }],
    ["osnova_outline", { file: "one.ts" }], ["osnova_warp", { symbol: "one" }], ["osnova_groundwork", {}],
    ["osnova_footing", { question: "one" }], ["osnova_settle", { diff: "--- a/one.ts\n+++ b/one.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n" }],
    ["osnova_plumb", { symbol: "one", sites: ["one.ts:1"] }], ["osnova_tests", { symbols: ["one"] }], ["osnova_unreferenced", {}],
  ];
  for (const [name, args] of tools) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, name).toBeFalsy();
    expect(JSON.stringify(result), name).toContain("osnova foundation: partial");
  }
});

it("ordinary query tools aggregate diagnostics instead of repeating file paths", async () => {
  for (let number = 0; number < 15; number += 1) {
    await fs.writeFile(path.join(workspace, `broken-${number}.ts`), "export function broken( {");
  }
  const tools: Array<[string, Record<string, unknown>]> = [
    ["osnova_ground", { question: "one" }], ["osnova_thread", { pattern: "one" }],
    ["osnova_outline", { file: "one.ts" }], ["osnova_warp", { symbol: "one" }],
  ];
  for (const [name, args] of tools) {
    const result = await client.callTool({ name, arguments: args });
    const text = JSON.stringify(result);
    expect(text, name).toContain("osnova foundation: partial (parse/syntax-errors=15)");
    expect(text, name).toContain("some files did not parse fully");
    expect(text, name).not.toContain("broken-0.ts");
  }
});

it("retries initialization after a grammar failure", async () => {
  vi.spyOn(loader, "getParser").mockRejectedValueOnce(new Error("unavailable"));
  const request = { name: "osnova_outline", arguments: { file: "one.ts" } };
  const first = await client.callTool(request);
  expect(first.isError).toBe(true);
  expect(JSON.stringify(first)).toContain("grammar-unavailable");
  const retry = await client.callTool(request);
  expect(retry.isError).toBeFalsy();
  expect(JSON.stringify(retry)).toContain("function one");
});

it("does not conceal a failed refresh write and can retry safely", async () => {
  const request = { name: "osnova_outline", arguments: { file: "one.ts" } };
  await client.callTool(request);
  await fs.appendFile(path.join(workspace, "one.ts"), "export function added() {}\n");
  const rename = fs.rename.bind(fs);
  let rejected = false;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (!rejected && path.basename(String(to)) === "index.json") {
      rejected = true;
      throw new Error("denied");
    }
    return rename(from, to);
  });
  const failed = await client.callTool(request);
  expect(failed.isError).toBe(true);
  expect(JSON.stringify(failed)).toContain("cache-write-failed");
  const cached = await fs.readdir(workspaceDirFor(cacheDir, workspace));
  expect(cached.some((name) => name.includes(".tmp-"))).toBe(false);
  const retry = await client.callTool(request);
  expect(retry.isError).toBeFalsy();
  expect(JSON.stringify(retry)).toContain("function added");
});

it("returns a tool error rather than an empty map after a workspace disappears", async () => {
  await client.callTool({ name: "osnova_groundwork", arguments: {} });
  await fs.rename(workspace, path.join(temporary, "moved"));
  const result = await client.callTool({ name: "osnova_groundwork", arguments: {} });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain("directory-unreadable");
});

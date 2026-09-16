import { afterAll, beforeAll, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { runCli } from "../src/cli/cli.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeAll(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-callers-surfaces-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "a.ts"), "export function work() { externalRequest(); }\n");
  await fs.writeFile(path.join(workspace, "b.ts"), "export function work() {}\n");
});

afterAll(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

it("CLI lists ambiguous targets rather than picking one", async () => {
  const output: string[] = [];
  await runCli(["callers", "work", "--workspace", workspace, "--cache-dir", cacheDir], {
    stdout: (text) => output.push(text), stderr: (text) => output.push(text),
  });
  expect(output.join("\n")).toContain("ambiguous symbol");
  expect(output.join("\n")).toContain("a.ts#work");
  expect(output.join("\n")).toContain("b.ts#work");
});

it("MCP exposes ambiguity and raw unresolved call sites", async () => {
  const { server } = createOsnovaMcpServer(workspace, { cacheDir });
  const client = new Client({ name: "caller-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const ambiguous = await client.callTool({ name: "osnova_warp", arguments: { symbol: "work" } });
    expect(JSON.stringify(ambiguous)).toContain("ambiguous symbol");
    const result = await client.callTool({ name: "osnova_warp", arguments: { symbol: "a.ts#work", direction: "out" } });
    expect(result.isError).toBeFalsy();
    const content = (result as { content?: ContentBlock[] }).content ?? [];
    const text = content.map((block) => block.type === "text" ? block.text : "").join("\n");
    expect(text).toContain("externalRequest");
    expect(text).toContain("a.ts:1");
    expect(text).toContain("not confirmed relationships");
  } finally {
    await client.close();
    await server.close();
  }
});

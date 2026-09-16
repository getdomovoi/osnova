import { afterAll, beforeAll, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { runCli, buildIndex, findTextDetailed } from "../src/index.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";

let temporary: string;
let workspace: string;
let cacheDir: string;
const source = `needle ${"x".repeat(40_000)}`;

beforeAll(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-output-budget-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "long.txt"), source);
});

afterAll(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

it("caps CLI text without changing the structured search result", async () => {
  const output: string[] = [];
  await runCli(["thread", "needle", "--workspace", workspace, "--cache-dir", cacheDir], {
    stdout: (text) => output.push(text), stderr: (text) => output.push(text),
  });
  expect(output[0]?.length).toBeLessThanOrEqual(16_384);
  expect(output[0]).toContain("[output truncated:");
  const index = await buildIndex(workspace, { cacheDir });
  expect(findTextDetailed(index, "needle").groups[0]?.matches[0]?.text).toBe(source);
});

it("caps MCP success and error responses with an explicit clipping notice", async () => {
  const { server } = createOsnovaMcpServer(workspace, { cacheDir });
  const client = new Client({ name: "budget-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const requests = [
      { name: "osnova_thread", arguments: { pattern: "needle" } },
      { name: "osnova_outline", arguments: { file: "missing".repeat(4000) } },
    ];
    for (const request of requests) {
      const result = await client.callTool(request);
      const content = (result as { content?: ContentBlock[] }).content ?? [];
      const text = content.map((block) => block.type === "text" ? block.text : "").join("\n");
      expect(text.length).toBeLessThanOrEqual(16_384);
      expect(text).toContain("[output truncated:");
      expect(Boolean(result.isError)).toBe(request.name === "osnova_outline");
    }
  } finally {
    await client.close();
    await server.close();
  }
});

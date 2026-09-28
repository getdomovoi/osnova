import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOsnovaMcpServer, mcpInstructions } from "../src/mcp/server.js";

const closers: Array<() => void> = [];
const temporaries: string[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const dir of temporaries.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

// Agents in a second worktree queried a server that indexes another checkout and repeated failing lookups;
// the instructions an MCP client receives at initialize name the indexed checkout before any call.
it("names the indexed checkout in the instructions sent at initialize", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-mcp-identity-"));
  temporaries.push(temporary);
  const workspace = path.join(temporary, "ws");
  await fs.mkdir(workspace, { recursive: true });
  const built = createOsnovaMcpServer(path.join(workspace, "."), { cacheDir: path.join(temporary, "cache") });
  closers.push(built.close);
  const client = new Client({ name: "t", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  const instructions = client.getInstructions() ?? "";
  expect(instructions.startsWith(mcpInstructions)).toBe(true);
  expect(instructions).toContain(`This server indexes ${path.resolve(workspace)}`);
});

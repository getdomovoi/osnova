import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";

// Every osnova tool reads the index and writes nothing, so each one must say so through the MCP
// annotation hints. Clients and directories read these to decide what a tool may do.
it("declares every tool as read-only, non-destructive, idempotent and closed-world", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { server, close } = createOsnovaMcpServer(process.cwd());
  await server.connect(serverTransport);
  const client = new Client({ name: "annotations-test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(10);
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
  } finally {
    await client.close();
    await server.close();
    close();
  }
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-search-surfaces-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
  for (let i = 0; i < 51; i += 1) {
    await fs.writeFile(path.join(workspace, `file-${i}.txt`), Array(11).fill("needle").join("\n"));
  }
});

afterAll(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

async function grep(pattern: string, args: string[] = []): Promise<string> {
  const lines: string[] = [];
  const code = await runCli([
    "grep", pattern, "--workspace", workspace, "--cache-dir", cacheDir, ...args,
  ], { stdout: (text) => lines.push(text), stderr: (text) => lines.push(text) });
  expect(code).toBe(0);
  return lines.join("\n");
}

async function searchMcp(args: Record<string, unknown>): Promise<{ text: string; isError: unknown }> {
  const { server } = createOsnovaMcpServer(workspace, { cacheDir });
  const client = new Client({ name: "search-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "osnova_thread", arguments: args });
    const content = (result as { content?: ContentBlock[] }).content ?? [];
    return { text: content.map((block) => block.type === "text" ? block.text : "").join("\n"), isError: result.isError };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("CLI search completeness", () => {
  it("discloses both default caps", async () => {
    const text = await grep("needle");
    expect(text).toContain("indexed-text search: 500/561 matches, 50/51 groups");
    expect(text).toContain("truncated: 61 matches omitted; 1 groups omitted");
  });

  it("does not mistake a zero display limit for no matches", async () => {
    const text = await grep("needle", ["-n", "0"]);
    expect(text).toContain("0/561 matches, 0/51 groups");
    expect(text).not.toContain("no matches");
  });

  it("qualifies empty results as indexed-text only", async () => {
    const text = await grep("absent");
    expect(text).toContain("no matches in indexed text");
    expect(text).not.toContain("truncated");
  });

  it.each(["-1", "1.5", "NaN", "Infinity", "oops"])("rejects invalid limit %s", async (limit) => {
    await expect(grep("needle", [`--limit=${limit}`])).rejects.toThrow(/safe integer/);
  });
});

describe("MCP search completeness", () => {
  it("discloses the same defaults as CLI", async () => {
    const result = await searchMcp({ pattern: "needle" });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("indexed-text search: 500/561 matches, 50/51 groups");
    expect(result.text).toContain("truncated: 61 matches omitted; 1 groups omitted");
  });

  it("honors explicit limits and path scope without claiming completeness", async () => {
    const result = await searchMcp({ pattern: "needle", in: "file-0.txt", limit: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("10/11 matches, 1/1 groups");
    expect(result.text).toContain("truncated: 1 matches omitted; 0 groups omitted");
  });

  it("reports invalid numeric limits as tool errors", async () => {
    const result = await searchMcp({ pattern: "needle", limit: -1 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("search limits");
  });
});

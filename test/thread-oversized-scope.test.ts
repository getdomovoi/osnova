import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { runCli } from "../src/cli/cli.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";
import { maximumIndexedFileSizeBytes } from "../src/types.js";

let temporary: string;
let workspace: string;
let cacheDir: string;

beforeAll(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-thread-oversized-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src", "small.ts"), "export function needle() { return 1; }\n");
  const line = "export const filler = 'needle';\n";
  await fs.writeFile(path.join(workspace, "src", "huge.ts"), line.repeat(Math.ceil((maximumIndexedFileSizeBytes + 1024) / line.length)));
});
afterAll(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

async function thread(args: Record<string, unknown>): Promise<string> {
  const { server } = createOsnovaMcpServer(workspace, { cacheDir });
  const client = new Client({ name: "osnova-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "osnova_thread", arguments: args });
    return ((result as { content?: readonly ContentBlock[] }).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
  } finally {
    await client.close();
  }
}

describe("a search scoped to a file above the size cap", () => {
  it("says the file was not searched instead of answering no matches alone", async () => {
    const text = await thread({ pattern: "needle", in: "src/huge.ts" });
    expect(text).toContain("no matches in indexed text");
    expect(text).toContain("1 file in this scope is above the 1 MB size cap and was not searched: src/huge.ts");
  });

  it("names the unsearched file next to real matches in a directory scope", async () => {
    const text = await thread({ pattern: "needle", in: "src" });
    expect(text).toContain("src/small.ts:1:");
    expect(text).toContain("1 file in this scope is above the 1 MB size cap and was not searched: src/huge.ts");
  });

  it("stays silent about the cap when the scope holds no oversized file", async () => {
    const text = await thread({ pattern: "needle", in: "src/small.ts" });
    expect(text).not.toContain("size cap and was not searched");
  });

  it("gives the same line on the CLI", async () => {
    const out: string[] = [];
    await runCli(["thread", "needle", "--in", "src", "--workspace", workspace, "--cache-dir", cacheDir], { stdout: (t) => out.push(t), stderr: () => {} });
    expect(out.join("\n")).toContain("1 file in this scope is above the 1 MB size cap and was not searched: src/huge.ts");
  });
});

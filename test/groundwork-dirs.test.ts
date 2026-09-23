import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { buildIndex } from "../src/index/build.js";
import { map } from "../src/query/map.js";
import { runCli } from "../src/cli/cli.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";
import type { OsnovaIndex } from "../src/types.js";

const DIRS = 20;
let workspace: string;
let cacheDir: string;
let index: OsnovaIndex;

beforeAll(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-groundwork-ws-"));
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-groundwork-cache-"));
  for (let i = 1; i <= DIRS; i += 1) {
    const dir = path.join(workspace, `d${String(i).padStart(2, "0")}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "f.ts"), `export function f${i}(): number { return 1; }\n`);
  }
  index = await buildIndex(workspace);
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

async function mcpGroundwork(args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const { server } = createOsnovaMcpServer(workspace, { cacheDir });
  const client = new Client({ name: "groundwork-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "osnova_groundwork", arguments: args });
    const content = (result as { content?: readonly ContentBlock[] }).content ?? [];
    return { isError: result.isError === true, text: content.map((c) => (c.type === "text" ? c.text : "")).join("") };
  } finally {
    await client.close();
  }
}

const clusterLines = (text: string): number => text.split("\n").filter((line) => /^d\d\d\/ \(/.test(line)).length;

describe("groundwork directory limit", () => {
  it("rejects a limit below one or a fraction on MCP instead of silently truncating the map", async () => {
    for (const maxDirs of [-3, 0, 2.5]) {
      const result = await mcpGroundwork({ maxDirs });
      expect(result.isError, String(maxDirs)).toBe(true);
      expect(result.text, String(maxDirs)).toMatch(/maxDirs must be a safe integer >= 1/);
    }
  });

  it("rejects the same values in the library, so no surface can drift from it", () => {
    for (const maxDirs of [-3, 0, 2.5, Number.NaN]) {
      expect(() => map(index, { maxDirs }), String(maxDirs)).toThrow(RangeError);
    }
    expect(map(index, { maxDirs: 1 }).clusters).toHaveLength(1);
  });

  it("uses one default of eight clusters on the library, the CLI and MCP", async () => {
    expect(map(index).clusters).toHaveLength(8);

    const lines: string[] = [];
    const io = { stdout: (text: string) => lines.push(text), stderr: () => {} };
    expect(await runCli(["groundwork", "--workspace", workspace, "--cache-dir", cacheDir], io)).toBe(0);
    expect(clusterLines(lines.join("\n"))).toBe(8);

    const mcp = await mcpGroundwork({});
    expect(mcp.isError).toBe(false);
    expect(clusterLines(mcp.text)).toBe(8);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";

let workspace: string;
let cacheDir: string;
let client: Client;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-mcp-args-ws-"));
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-mcp-args-cache-"));
  fs.mkdirSync(path.join(workspace, "src"));
  for (const name of ["one", "two", "three"]) {
    fs.writeFileSync(path.join(workspace, "src", `f_${name}.ts`), `export function f_${name}(): number { return 1; }\n`);
  }
  fs.writeFileSync(path.join(workspace, "top.ts"), "export function top(): number { return 1; }\n");
  const { server } = createOsnovaMcpServer(workspace, { cacheDir });
  client = new Client({ name: "osnova-args-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

async function call(name: string, args: unknown): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
  const content = (result as { content?: readonly ContentBlock[] }).content ?? [];
  return { isError: result.isError === true, text: content.map((c) => (c.type === "text" ? c.text : "")).join("") };
}

describe("MCP arguments are held to the advertised schema", () => {
  it("rejects a boolean sent as a string instead of flipping literal search to regex", async () => {
    // Before: fixed "true" read as absent, so "f_." ran as a regex and matched every file.
    const wrong = await call("osnova_thread", { pattern: "f_.", fixed: "true" });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toMatch(/"fixed" must be a boolean, got string/);
    const right = await call("osnova_thread", { pattern: "f_.", fixed: true });
    expect(right.isError).toBe(false);
    expect(right.text).toContain("0/0 matches");
  });

  it("rejects a misspelled argument instead of silently dropping the scope", async () => {
    // Before: "scopes" was ignored and the whole repository was scanned.
    const typo = await call("osnova_unreferenced", { scopes: "src", includeExported: true });
    expect(typo.isError).toBe(true);
    expect(typo.text).toMatch(/unknown argument "scopes" for osnova_unreferenced; expected one of scope, kinds, limit, includeExported/);
    const right = await call("osnova_unreferenced", { scope: "src", includeExported: true });
    expect(right.isError).toBe(false);
    expect(right.text).toContain("scope src");
  });

  it("rejects an argument no tool declares", async () => {
    const bogus = await call("osnova_ground", { question: "f_one", bogusArgument: { nested: [1, 2, 3] } });
    expect(bogus.isError).toBe(true);
    expect(bogus.text).toMatch(/unknown argument "bogusArgument" for osnova_ground/);
  });

  it("reports a wrong-typed required argument as wrong-typed, not missing", async () => {
    const wrong = await call("osnova_ground", { question: 42 });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toMatch(/"question" must be a string, got number/);
    const missing = await call("osnova_ground", {});
    expect(missing.text).toMatch(/missing required string argument "question"/);
  });

  it("rejects a wrong-typed scope instead of answering for the whole repository", async () => {
    const wrong = await call("osnova_ground", { question: "f_one", in: 42 });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toMatch(/"in" must be a string, got number/);
  });

  it("rejects a number sent as a string on every tool the same way", async () => {
    for (const [tool, args] of [
      ["osnova_ground", { question: "f_one", limit: "5" }],
      ["osnova_thread", { pattern: "f_", limit: "5" }],
      ["osnova_groundwork", { maxDirs: "3" }],
      ["osnova_warp", { symbol: "f_one", depth: "2" }],
    ] as const) {
      const result = await call(tool, args);
      expect(result.isError, tool).toBe(true);
      expect(result.text, tool).toMatch(/must be a number, got string/);
    }
  });

  it("rejects a boolean sent as a string on every tool the same way", async () => {
    for (const [tool, args] of [
      ["osnova_ground", { question: "f_one", full: "true" }],
      ["osnova_ground", { question: "f_one", lean: "yes" }],
      ["osnova_thread", { pattern: "f_", ignoreCase: 1 }],
      ["osnova_warp", { symbol: "f_one", full: "false" }],
    ] as const) {
      const result = await call(tool, args);
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(result.text, tool).toMatch(/must be a boolean/);
    }
  });

  it("still leaves range checks to the engine", async () => {
    const negative = await call("osnova_thread", { pattern: "f_", limit: -1 });
    expect(negative.isError).toBe(true);
    expect(negative.text).toContain("search limits");
  });
});

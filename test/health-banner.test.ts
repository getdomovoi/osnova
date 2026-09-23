import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { formatIndexHealthSummary } from "../src/query/format.js";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";
import type { FileCard, IndexDiagnostic } from "../src/types.js";

function index(diagnostics: IndexDiagnostic[]) {
  const files = new Map<string, FileCard>();
  for (const diagnostic of diagnostics) {
    files.set(diagnostic.path, {
      path: diagnostic.path, language: "typescript", hash: "fixture", size: 0, lineCount: 0,
      text: "", symbols: [], diagnostics: [diagnostic], reExports: [],
    });
  }
  return new OsnovaIndexImpl("/fixture", files, []);
}

describe("health summary", () => {
  it("does not call a file skipped for size a parse failure", () => {
    const summary = formatIndexHealthSummary(index([{ phase: "scan", path: "big.js", code: "file-too-large" }]));
    expect(summary).not.toContain("did not parse");
    expect(summary).toBe("osnova foundation: partial (scan/file-too-large=1); 1 file above the 1 MB size cap is not indexed");
  });

  it("states both causes when both are present", () => {
    const summary = formatIndexHealthSummary(index([
      { phase: "scan", path: "a.js", code: "file-too-large" },
      { phase: "scan", path: "b.js", code: "file-too-large" },
      { phase: "parse", path: "c.sh", code: "syntax-errors" },
    ]));
    expect(summary).toBe("osnova foundation: partial (scan/file-too-large=2, parse/syntax-errors=1); 2 files above the 1 MB size cap are not indexed; some files did not parse fully");
  });

  it("never folds files that are missing from the index into the overflow count", () => {
    // Alphabetically scan/ sorts after cache/, parse/ and read/, so with four other kinds present the
    // one category that makes omission counts wrong was the one hidden behind "+1 categories".
    const summary = formatIndexHealthSummary(index([
      { phase: "read", path: "a", code: "unreadable" },
      { phase: "parse", path: "b", code: "syntax-errors" },
      { phase: "cache", path: "c", code: "busy" },
      { phase: "parse", path: "e", code: "extraction-failed" },
      { phase: "scan", path: "big.js", code: "file-too-large" },
    ]));
    expect(summary).toContain("scan/file-too-large=1");
    expect(summary).toMatch(/^osnova foundation: partial \(scan\/file-too-large=1, /);
  });
});

describe("MCP names the file a scoped query is about", () => {
  let workspace: string;
  let cacheDir: string;
  let client: Client;

  beforeAll(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-banner-ws-"));
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-banner-cache-"));
    fs.writeFileSync(path.join(workspace, "small.ts"), "export function small(): number { return 1; }\n");
    fs.writeFileSync(path.join(workspace, "big.js"), `// ${"a".repeat(1_100_000)}\nexport function big() {}\n`);
    fs.writeFileSync(path.join(workspace, "poison.sh"), "broken_helper() {\n  if [[ \n");
    const { server } = createOsnovaMcpServer(workspace, { cacheDir });
    client = new Client({ name: "banner-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  async function call(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    return ((result as { content?: readonly ContentBlock[] }).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
  }

  it("says an outlined file failed to parse", async () => {
    const text = await call("osnova_outline", { file: "poison.sh" });
    expect(text).toContain("osnova: poison.sh parse/syntax-errors; results for this file are incomplete");
  });

  it("says an outlined file was not indexed at all", async () => {
    const text = await call("osnova_outline", { file: "big.js" });
    expect(text).toContain("osnova: big.js scan/file-too-large; this file is not indexed");
  });

  it("adds nothing for a clean file", async () => {
    const text = await call("osnova_outline", { file: "small.ts" });
    expect(text).not.toMatch(/^osnova: small\.ts /m);
  });
});

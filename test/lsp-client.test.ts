import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LspClient, lspLimits } from "../src/enrichment/client.js";

const worker = path.join(import.meta.dirname, "fixtures/lsp/server.mjs");
const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

async function start(mode = "normal", limits = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-lsp-client-"));
  dirs.push(dir);
  const log = path.join(dir, "events.json");
  const client = new LspClient({ id: "fake", executable: process.execPath, args: [worker, mode, log], workspace: dir, languages: ["typescript"] }, dir, limits);
  await client.initialize();
  const uri = pathToFileURL(path.join(dir, "a.ts")).href;
  client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text: "target caf\u00e9" } });
  return { client, uri, log };
}

describe("bounded LSP stdio", () => {
  it("frames UTF-8 fragmented replies and completes the LSP lifecycle", async () => {
    const { client, uri, log } = await start("fragment");
    try {
      expect(await client.request("textDocument/references", { textDocument: { uri }, position: { line: 0, character: 0 }, context: { includeDeclaration: true } })).toHaveLength(1);
      expect(await client.request("test/events", {})).toMatchObject({ text: "target caf\u00e9", languages: ["typescript"] });
    } finally { await client.close(); }
    expect(JSON.parse(await fs.readFile(log, "utf8"))).toEqual(["initialize", "initialized", "textDocument/didOpen", "textDocument/references", "test/events", "shutdown", "exit"]);
  });

  it.each(["malformed", "oversized", "json", "exit", "duplicate-header", "long-header"])("rejects %s responses without hanging", async (mode) => {
    const { client, uri } = await start(mode);
    try {
      await expect(client.request("textDocument/definition", { textDocument: { uri }, position: { line: 0, character: 0 } })).rejects.toThrow();
    } finally { await client.close(); }
  });

  it("cancels timed-out requests and remains usable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, uri } = await start("timeout");
    try {
      const pending = client.request("textDocument/references", { textDocument: { uri } });
      const rejected = expect(pending).rejects.toThrow("request-timeout");
      await vi.advanceTimersByTimeAsync(lspLimits.requestTimeoutMs);
      await rejected;
      const result = await client.request("test/events", {}) as { events: string[] };
      expect(result.events).toContain("$/cancelRequest");
    } finally { vi.useRealTimers(); await client.close(); }
  });

  it("cancels on caller abort, rejects server errors, and recovers", async () => {
    const timeout = await start("timeout");
    const controller = new AbortController();
    try {
      const pending = timeout.client.request("textDocument/references", { textDocument: { uri: timeout.uri } }, controller.signal);
      controller.abort();
      await expect(pending).rejects.toThrow("cancelled");
      expect(await timeout.client.request("test/events", {})).toMatchObject({ events: expect.arrayContaining(["$/cancelRequest"]) });
    } finally { await timeout.client.close(); }
    const { client, uri } = await start("error");
    try {
      await expect(client.request("textDocument/definition", { textDocument: { uri }, position: { line: 0, character: 0 } })).rejects.toThrow("rpc-error");
      expect(await client.request("textDocument/definition", { textDocument: { uri }, position: { line: 0, character: 1 } })).toHaveLength(1);
    } finally { await client.close(); }
  });

  it("bounds request counts but reserves graceful shutdown", async () => {
    const { client, log } = await start("normal", { maxRequests: 2 });
    await client.request("test/events", {});
    await expect(client.request("test/events", {})).rejects.toThrow("request-limit");
    await client.close();
    expect(JSON.parse(await fs.readFile(log, "utf8"))).toEqual(expect.arrayContaining(["shutdown", "exit"]));
  });

  it("rejects unsolicited edits and handles coalesced frames", async () => {
    const { client, uri } = await start("server-request");
    try {
      expect(await client.request("textDocument/definition", { textDocument: { uri }, position: { line: 0, character: 0 } })).toHaveLength(1);
      expect(await client.request("test/events", {})).toMatchObject({ events: expect.arrayContaining(["response"]) });
    } finally { await client.close(); }
  });

  it("bounds stderr, pending requests, and shutdown", async () => {
    const noisy = await start("stderr", { maxSessionBytes: 4096 });
    try {
      const first = await noisy.client.request("textDocument/references", { textDocument: { uri: noisy.uri }, position: { line: 0, character: 0 } }).then(() => "resolved", (error: Error) => error.message);
      if (first !== "session-byte-limit") {
        expect(first).toBe("request-timeout");
        await expect(noisy.client.request("test/events", {})).rejects.toThrow("session-byte-limit");
      }
    } finally { await noisy.client.close(); }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const slow = await start("timeout", { maxPending: 1 });
    try {
      const pending = slow.client.request("textDocument/references", { textDocument: { uri: slow.uri } });
      const rejected = expect(pending).rejects.toThrow("request-timeout");
      await expect(slow.client.request("test/events", {})).rejects.toThrow("pending-limit");
      await vi.advanceTimersByTimeAsync(lspLimits.requestTimeoutMs);
      await rejected;
    } finally { vi.useRealTimers(); await slow.client.close(); }
    const hung = await start("hang-shutdown", { shutdownTimeoutMs: 30 });
    await hung.client.close();
    await expect(hung.client.request("test/events", {})).rejects.toThrow();
  });

  it("terminates only its child when the session deadline expires", async () => {
    const { client, uri } = await start("timeout", { sessionTimeoutMs: 400 });
    try { await expect(client.request("textDocument/references", { textDocument: { uri } })).rejects.toThrow("session-timeout"); }
    finally { await client.close(); }
  });
});

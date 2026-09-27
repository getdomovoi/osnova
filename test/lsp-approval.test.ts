import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FileCard, OsnovaIndex } from "../src/types.js";
import { configureLspEnrichment, refreshLspEnrichment } from "../src/enrichment/enrichment.js";
import type { LspPolicy, LspQuery } from "../src/enrichment/types.js";
import { workspaceDirFor } from "../src/cache/cache.js";

const worker = path.join(import.meta.dirname, "fixtures/lsp/server.mjs");
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-lsp-approval-"));
  dirs.push(dir);
  const root = path.join(dir, "workspace");
  const cacheDir = path.join(dir, "cache");
  await fs.mkdir(root);
  await fs.mkdir(cacheDir);
  const text = "target typescript";
  await fs.writeFile(path.join(root, "a.txt"), text);
  const hash = createHash("sha256").update(text).digest("hex");
  const card: FileCard = { path: "a.txt", language: "typescript", hash, size: text.length, lineCount: 1, text, symbols: [] };
  const index: OsnovaIndex = { root, files: new Map([["a.txt", card]]), symbols: new Map(), edges: [], incoming: () => [], outgoing: () => [], edgesForFile: () => [], degree: () => ({ incoming: 0, outgoing: 0 }) };
  const queries: LspQuery[] = [{ file: "a.txt", sourceHash: hash, method: "references", position: { line: 0, character: 0 } }];
  const policyFor = (log: string): LspPolicy => ({ version: 1, servers: [{ id: "ts", workspace: root, languages: ["typescript"], executable: process.execPath, args: [worker, "normal", path.join(dir, log), "typescript"] }] });
  return { dir, root, cacheDir, index, queries, policyFor };
}

describe("LSP enrichment launches only an approved policy", () => {
  it("does not launch the stored policy when the caller presents no approval", async () => {
    const f = await setup();
    await configureLspEnrichment(f.root, f.policyFor("stored.log"), { cacheDir: f.cacheDir });
    const result = await refreshLspEnrichment(f.index, { enabled: true, queries: f.queries, cacheDir: f.cacheDir });
    await expect(fs.access(path.join(f.dir, "stored.log"))).rejects.toThrow();
    expect(result.status).toBe("unavailable");
    expect(result.diagnostics.some((d) => d.code === "policy-not-approved")).toBe(true);
  });

  it("does not launch a policy.json rewritten after it was approved", async () => {
    const f = await setup();
    const approve = await configureLspEnrichment(f.root, f.policyFor("approved.log"), { cacheDir: f.cacheDir });
    const stored = path.join(workspaceDirFor(f.cacheDir, f.root), "lsp", "policy.json");
    await fs.writeFile(stored, JSON.stringify(f.policyFor("planted.log")));
    const result = await refreshLspEnrichment(f.index, { enabled: true, approve, queries: f.queries, cacheDir: f.cacheDir });
    await expect(fs.access(path.join(f.dir, "planted.log"))).rejects.toThrow();
    await expect(fs.access(path.join(f.dir, "approved.log"))).rejects.toThrow();
    expect(result.diagnostics.some((d) => d.code === "policy-not-approved")).toBe(true);
  });

  it("launches the stored policy when the caller presents the approval configure returned", async () => {
    const f = await setup();
    const approve = await configureLspEnrichment(f.root, f.policyFor("approved.log"), { cacheDir: f.cacheDir });
    expect(approve).toMatch(/^[a-f0-9]{64}$/);
    const result = await refreshLspEnrichment(f.index, { enabled: true, approve, queries: f.queries, cacheDir: f.cacheDir });
    expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
    await expect(fs.access(path.join(f.dir, "approved.log"))).resolves.toBeUndefined();
  });

  it("treats a policy passed in the call as approved by that call", async () => {
    const f = await setup();
    const result = await refreshLspEnrichment(f.index, { enabled: true, policy: f.policyFor("inline.log"), queries: f.queries, cacheDir: f.cacheDir });
    expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
  });
});

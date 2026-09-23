import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FileCard, LanguageId, OsnovaIndex } from "../src/types.js";
import { configureLspEnrichment, loadLspEnrichment, refreshLspEnrichment } from "../src/enrichment/enrichment.js";
import type { LspPolicy, LspQuery } from "../src/enrichment/types.js";
import { serializeArtifact } from "../src/index/serialize.js";
import { workspaceDirFor } from "../src/cache/cache.js";
import { buildIndex } from "../src/index/build.js";

const worker = path.join(import.meta.dirname, "fixtures/lsp/server.mjs");
const languages: LanguageId[] = ["typescript", "tsx", "javascript", "python", "go", "rust", "java", "c_sharp"];
const dirs: string[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

async function setup(mode = "normal") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-lsp-enrich-"));
  dirs.push(dir);
  const root = path.join(dir, "workspace");
  const cacheDir = path.join(dir, "cache");
  await fs.mkdir(root);
  await fs.mkdir(cacheDir);
  const files = new Map<string, FileCard>();
  for (const language of languages) {
    const file = `${language}.txt`;
    const text = `target ${language}`;
    await fs.writeFile(path.join(root, file), text);
    files.set(file, { path: file, language, hash: hash(text), size: text.length, lineCount: 1, text, symbols: [] });
  }
  const index: OsnovaIndex = { root, files, symbols: new Map(), edges: [], incoming: () => [], outgoing: () => [], edgesForFile: () => [], degree: () => ({ incoming: 0, outgoing: 0 }) };
  const queries: LspQuery[] = [...files.values()].map((f) => ({ file: f.path, sourceHash: f.hash, method: "references", position: { line: 0, character: 0 } }));
  const policy: LspPolicy = { version: 1, servers: languages.map((language) => ({ id: language, workspace: root, languages: [language], executable: process.execPath, args: [worker, mode, path.join(cacheDir, `${language}.log`), language === "tsx" ? "typescriptreact" : language === "c_sharp" ? "csharp" : language] })) };
  return { root, cacheDir, index, files, queries, policy };
}

describe("opt-in LSP sidecar", () => {
  it("uses the same canonical workspace identity as the structural engine", async () => {
    const f = await setup();
    await fs.writeFile(path.join(f.root, "source.ts"), "export const target = 1;\n");
    const approve = await configureLspEnrichment(f.root, f.policy, { cacheDir: f.cacheDir });
    const index = await buildIndex(f.root, { cacheDir: f.cacheDir });
    const card = index.files.get("source.ts")!;
    const result = await refreshLspEnrichment(index, { enabled: true, approve, queries: [{ file: card.path, sourceHash: card.hash, method: "references", position: { line: 0, character: 0 } }], cacheDir: f.cacheDir });
    expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
    expect(result.results).toHaveLength(1);
  });

  it("removes the writer lock even when the locked write reports an error", async () => {
    const f = await setup();
    const rename = fs.rename.bind(fs);
    // Taking the cache lock is itself a rename of the staged lock directory into place, so failing
    // whichever rename comes first would fail the acquisition rather than the write this test is
    // about. Matched by suffix: on macOS the temporary root reaches the call as /private/var while
    // the path built here says /var, and path.resolve does not reconcile the two.
    const lockSuffix = path.join("lsp", "writer.lock");
    let failures = 1;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (failures > 0 && !String(to).endsWith(lockSuffix)) {
        failures -= 1;
        throw Object.assign(new Error("rename failed"), { code: "EIO" });
      }
      return rename(from, to);
    });
    await expect(configureLspEnrichment(f.root, f.policy, { cacheDir: f.cacheDir })).rejects.toThrow(/rename failed/);
    vi.restoreAllMocks();
    await expect(fs.access(path.join(workspaceDirFor(f.cacheDir, f.root), "lsp", "writer.lock"))).rejects.toThrow();
  });
  it("does not mistake an unchanged binary fallback card for stale source", async () => {
    const f = await setup();
    const bytes = Buffer.from([0, 1, 2, 3]);
    await fs.writeFile(path.join(f.root, "asset.bin"), bytes);
    f.files.set("asset.bin", { path: "asset.bin", language: "fallback", text: "", hash: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, lineCount: 0, symbols: [] });
    const result = await refreshLspEnrichment(f.index, { enabled: true, policy: f.policy, queries: [f.queries[0]!], cacheDir: f.cacheDir });
    expect(result.status).toBe("complete");
    expect(result.results).toHaveLength(1);
  });
  it("does not launch on configuration, load, or disabled refresh", async () => {
    const f = await setup();
    await configureLspEnrichment(f.root, f.policy, { cacheDir: f.cacheDir });
    expect((await loadLspEnrichment(f.index, { cacheDir: f.cacheDir })).policy).toEqual(f.policy);
    expect((await refreshLspEnrichment(f.index, { cacheDir: f.cacheDir, queries: f.queries })).status).toBe("disabled");
    await expect(fs.access(path.join(f.cacheDir, "typescript.log"))).rejects.toThrow();
  });

  it("dispatches every supported language and overlapping servers without shadowing", async () => {
    const f = await setup();
    const policy = { ...f.policy, servers: [...f.policy.servers, { ...f.policy.servers[0]!, id: "second-ts", args: [worker, "fragment"] }] };
    const before = serializeArtifact(f.index);
    const result = await refreshLspEnrichment(f.index, { enabled: true, policy, queries: f.queries, cacheDir: f.cacheDir });
    expect(result.status).toBe("complete");
    expect(result.results).toHaveLength(9);
    expect(new Set(result.results.map((r) => r.language))).toEqual(new Set(languages));
    expect(result.results.every((r) => r.evidence.source === "lsp" && r.evidence.claim === "server-locations" && r.baseGeneration === result.baseGeneration && r.locations[0]?.sourceHash === r.query.sourceHash)).toBe(true);
    expect(serializeArtifact(f.index).equals(before)).toBe(true);
    for (const language of languages) expect(JSON.parse(await fs.readFile(path.join(f.cacheDir, `${language}.log`), "utf8"))).toEqual(expect.arrayContaining(["initialize", "textDocument/didOpen", "textDocument/references", "shutdown", "exit"]));
  });

  it("retains valid evidence with subset refresh and recomputes after dependency changes", async () => {
    const f = await setup();
    const approve = await configureLspEnrichment(f.root, f.policy, { cacheDir: f.cacheDir });
    const a = await refreshLspEnrichment(f.index, { enabled: true, approve, queries: f.queries, cacheDir: f.cacheDir });
    const b = await refreshLspEnrichment(f.index, { enabled: true, approve, queries: [], cacheDir: f.cacheDir });
    expect(b.results).toEqual(a.results);
    expect(b.reused).toBe(8);
    const staleInput = await refreshLspEnrichment(f.index, { enabled: true, approve, queries: [{ ...f.queries[0]!, sourceHash: hash("obsolete") }], cacheDir: f.cacheDir });
    expect(staleInput.results).toEqual(a.results);
    expect(staleInput.diagnostics.some((d) => d.code === "stale-query")).toBe(true);
    const old = f.files.get("python.txt")!;
    const text = "target changed";
    await fs.writeFile(path.join(f.root, old.path), text);
    f.files.set(old.path, { ...old, text, hash: hash(text), size: text.length });
    const loaded = await loadLspEnrichment(f.index, { cacheDir: f.cacheDir });
    expect(loaded.results).toHaveLength(0);
    expect(loaded.diagnostics.some((d) => d.code === "stale-generation")).toBe(true);
    const updated = f.queries.map((q) => q.file === old.path ? { ...q, sourceHash: hash(text) } : q);
    const c = await refreshLspEnrichment(f.index, { enabled: true, approve, queries: updated, cacheDir: f.cacheDir });
    expect(c.status).toBe("complete");
    expect(c.results).toHaveLength(8);
    expect(c.reused).toBe(0);
    expect(c.baseGeneration).not.toBe(a.baseGeneration);
    expect(c.results.every((r) => r.baseGeneration === c.baseGeneration)).toBe(true);
  });

  it("reports missing servers, errors, and unsupported locations without breaking structural data", async () => {
    const f = await setup("error");
    const policy = { ...f.policy, servers: [{ ...f.policy.servers[0]!, executable: path.join(f.root, "missing") }, f.policy.servers[1]!] };
    const result = await refreshLspEnrichment(f.index, { enabled: true, policy, queries: f.queries, cacheDir: f.cacheDir });
    expect(result.status).toBe("unavailable");
    expect(result.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(["server-unavailable", "rpc-error", "no-server"]));
    expect(f.index.files.size).toBe(8);
  });

  it("rejects stale disk sources and old query offsets", async () => {
    const f = await setup();
    await fs.writeFile(path.join(f.root, "python.txt"), "target edited");
    const stale = await refreshLspEnrichment(f.index, { enabled: true, policy: f.policy, queries: f.queries, cacheDir: f.cacheDir });
    expect(stale.results).toHaveLength(0);
    expect(stale.diagnostics.some((d) => d.code === "stale-source")).toBe(true);
    const old = f.files.get("python.txt")!;
    f.files.set(old.path, { ...old, text: "target edited", hash: hash("target edited") });
    const result = await refreshLspEnrichment(f.index, { enabled: true, policy: f.policy, queries: f.queries, cacheDir: f.cacheDir });
    expect(result.status).toBe("partial");
    expect(result.results).toHaveLength(7);
    expect(result.diagnostics.some((d) => d.code === "stale-query")).toBe(true);
  });

  it("preserves partial evidence on failed retries and discloses stored failures on load", async () => {
    const f = await setup("partial");
    const approve = await configureLspEnrichment(f.root, f.policy, { cacheDir: f.cacheDir });
    const first = await refreshLspEnrichment(f.index, { enabled: true, approve, queries: f.queries, cacheDir: f.cacheDir });
    expect(first.status).toBe("partial");
    expect(first.results).toHaveLength(8);
    for (const language of languages) await fs.writeFile(path.join(f.cacheDir, `${language}.log.fail`), "fail");
    const retry = await refreshLspEnrichment(f.index, { enabled: true, approve, cacheDir: f.cacheDir });
    expect(retry.results).toEqual(first.results);
    expect(retry.diagnostics.some((d) => d.code === "rpc-error")).toBe(true);
    const loaded = await loadLspEnrichment(f.index, { cacheDir: f.cacheDir });
    expect(loaded.status).toBe("partial");
    expect(loaded.diagnostics.some((d) => d.code === "rpc-error")).toBe(true);
  });

  it("keeps missing-language failure visible after load", async () => {
    const f = await setup();
    const policy = { ...f.policy, servers: f.policy.servers.slice(0, 1) };
    const approve = await configureLspEnrichment(f.root, policy, { cacheDir: f.cacheDir });
    expect((await refreshLspEnrichment(f.index, { enabled: true, approve, queries: f.queries, cacheDir: f.cacheDir })).status).toBe("partial");
    const loaded = await loadLspEnrichment(f.index, { cacheDir: f.cacheDir });
    expect(loaded.status).toBe("partial");
    expect(loaded.diagnostics.filter((d) => d.code === "no-server")).toHaveLength(7);
  });

  it.each(["bad-location", "unsupported", "encoding", "mutate"])("reports %s limitations explicitly", async (mode) => {
    const f = await setup(mode);
    const result = await refreshLspEnrichment(f.index, { enabled: true, policy: f.policy, queries: f.queries, cacheDir: f.cacheDir });
    expect(result.status).not.toBe("complete");
    expect(result.diagnostics.length).toBeGreaterThan(0);
    if (mode === "mutate") expect(result.results).toHaveLength(0);
    if (mode === "bad-location") expect(result.results.every((r) => r.locations.length === 0 && r.status === "partial")).toBe(true);
  });

  it("accepts definition links and invalidates deleted targets and renamed sources", async () => {
    const f = await setup("link");
    const approve = await configureLspEnrichment(f.root, f.policy, { cacheDir: f.cacheDir });
    const queries = f.queries.map((q) => ({ ...q, method: "definition" as const }));
    const first = await refreshLspEnrichment(f.index, { enabled: true, approve, queries, cacheDir: f.cacheDir });
    expect(first.results).toHaveLength(8);
    expect(first.results.every((r) => r.locations.length === 1)).toBe(true);
    const old = f.files.get("python.txt")!;
    await fs.rename(path.join(f.root, old.path), path.join(f.root, "renamed.txt"));
    f.files.delete(old.path);
    f.files.set("renamed.txt", { ...old, path: "renamed.txt" });
    const next = await refreshLspEnrichment(f.index, { enabled: true, approve, queries: [{ ...queries.find((q) => q.file === old.path)!, file: "renamed.txt" }], cacheDir: f.cacheDir });
    expect(next.results).toHaveLength(8);
    expect(next.results.some((r) => r.query.file === old.path)).toBe(false);
    expect(next.results.some((r) => r.query.file === "renamed.txt")).toBe(true);
    expect(next.reused).toBe(0);
  });

  it("contains corrupt caches, rejects relative launches, and never writes outside cache", async () => {
    const f = await setup();
    await expect(configureLspEnrichment(f.root, { version: 1, servers: [{ ...f.policy.servers[0]!, executable: "node" }] }, { cacheDir: f.cacheDir })).rejects.toThrow("invalid-policy");
    const approve = await configureLspEnrichment(f.root, f.policy, { cacheDir: f.cacheDir });
    const dir = path.join(workspaceDirFor(f.cacheDir, f.root), "lsp");
    await fs.writeFile(path.join(dir, "results.json"), "{");
    const loaded = await loadLspEnrichment(f.index, { cacheDir: f.cacheDir });
    expect(loaded.status).toBe("unavailable");
    expect(loaded.diagnostics.some((d) => d.code === "cache-unreadable")).toBe(true);
    const recovered = await refreshLspEnrichment(f.index, { enabled: true, approve, queries: f.queries, cacheDir: f.cacheDir });
    expect(recovered.results).toHaveLength(8);
    expect((await fs.readdir(f.root)).sort()).toEqual([...f.files.keys()].sort());
    const blocked = path.join(f.cacheDir, "not-a-directory");
    await fs.writeFile(blocked, "blocked");
    const unavailable = await refreshLspEnrichment(f.index, { enabled: true, policy: f.policy, queries: f.queries, cacheDir: blocked });
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.diagnostics.some((d) => d.code === "cache-unavailable")).toBe(true);
  });

  it("rejects competing writers without deleting their lock or launching servers", async () => {
    const f = await setup();
    const approve = await configureLspEnrichment(f.root, f.policy, { cacheDir: f.cacheDir });
    const lock = path.join(workspaceDirFor(f.cacheDir, f.root), "lsp/writer.lock");
    await fs.writeFile(lock, "owned elsewhere");
    const result = await refreshLspEnrichment(f.index, { enabled: true, approve, queries: f.queries, cacheDir: f.cacheDir });
    expect(result.diagnostics.some((d) => d.code === "cache-busy")).toBe(true);
    expect(await fs.readFile(lock, "utf8")).toBe("owned elsewhere");
    await expect(fs.access(path.join(f.cacheDir, "typescript.log"))).rejects.toThrow();
  });

  it("reclaims a writer lock whose owning process has exited", async () => {
    const f = await setup();
    const approve = await configureLspEnrichment(f.root, f.policy, { cacheDir: f.cacheDir });
    const lock = path.join(workspaceDirFor(f.cacheDir, f.root), "lsp/writer.lock");
    const exited = spawnSync(process.execPath, ["-e", ""]);
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: exited.pid, host: os.hostname(), token: "00000000-0000-4000-8000-000000000000" }));
    const result = await refreshLspEnrichment(f.index, { enabled: true, approve, queries: f.queries, cacheDir: f.cacheDir });
    expect(result.status, JSON.stringify(result.diagnostics)).toBe("complete");
    await expect(fs.access(lock)).rejects.toThrow();
  });

  it("keeps a writer lock whose owning process is still alive", async () => {
    const f = await setup();
    const approve = await configureLspEnrichment(f.root, f.policy, { cacheDir: f.cacheDir });
    const lock = path.join(workspaceDirFor(f.cacheDir, f.root), "lsp/writer.lock");
    const owner = JSON.stringify({ pid: process.pid, host: os.hostname(), token: "00000000-0000-4000-8000-000000000001" });
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, "owner.json"), owner);
    const result = await refreshLspEnrichment(f.index, { enabled: true, approve, queries: f.queries, cacheDir: f.cacheDir });
    expect(result.diagnostics.some((d) => d.code === "cache-busy")).toBe(true);
    expect(await fs.readFile(path.join(lock, "owner.json"), "utf8")).toBe(owner);
  });

  it("bounds requests per server without starving later languages and retries failures", async () => {
    const f = await setup();
    const policy = { ...f.policy, limits: { maxRequests: 2 } };
    const approve = await configureLspEnrichment(f.root, policy, { cacheDir: f.cacheDir });
    const queries = [...f.queries, { ...f.queries[0]!, position: { line: 0, character: 1 } }];
    const result = await refreshLspEnrichment(f.index, { enabled: true, approve, queries, cacheDir: f.cacheDir });
    expect(result.results).toHaveLength(8);
    expect(result.diagnostics.some((d) => d.code === "request-limit")).toBe(true);
    const retry = await refreshLspEnrichment(f.index, { enabled: true, approve, cacheDir: f.cacheDir });
    expect(retry.status).toBe("complete");
    expect(retry.results).toHaveLength(9);
    expect(retry.reused).toBe(8);
  });

  it("honors nested workspace selection and caller generations", async () => {
    const f = await setup();
    const nested = path.join(f.root, "pkg");
    await fs.mkdir(nested);
    const old = f.files.get("typescript.txt")!;
    await fs.rename(path.join(f.root, old.path), path.join(nested, old.path));
    f.files.delete(old.path);
    f.files.set(`pkg/${old.path}`, { ...old, path: `pkg/${old.path}` });
    const policy = { ...f.policy, servers: [...f.policy.servers, { ...f.policy.servers[0]!, id: "nested", workspace: nested, args: [worker] }] };
    const approve = await configureLspEnrichment(f.root, policy, { cacheDir: f.cacheDir });
    const queries = f.queries.map((q) => q.file === old.path ? { ...q, file: `pkg/${old.path}` } : q);
    const first = await refreshLspEnrichment(f.index, { enabled: true, approve, queries, cacheDir: f.cacheDir, baseGeneration: "generation-a" });
    expect(first.results).toHaveLength(9);
    const loaded = await loadLspEnrichment(f.index, { cacheDir: f.cacheDir, baseGeneration: "generation-b" });
    expect(loaded.results).toHaveLength(0);
    const next = await refreshLspEnrichment(f.index, { enabled: true, approve, cacheDir: f.cacheDir, baseGeneration: "generation-b" });
    expect(next.results).toHaveLength(9);
    expect(next.reused).toBe(0);
  });

  it("releases obsolete query slots after source edits without reusing old offsets", async () => {
    const f = await setup();
    const approve = await configureLspEnrichment(f.root, f.policy, { cacheDir: f.cacheDir });
    const q = f.queries[0]!;
    await refreshLspEnrichment(f.index, { enabled: true, approve, queries: [q], cacheDir: f.cacheDir });
    const card = f.files.get(q.file)!;
    const text = "target changed offsets";
    await fs.writeFile(path.join(f.root, q.file), text);
    f.files.set(q.file, { ...card, text, hash: hash(text), size: text.length });
    const moved = { ...q, sourceHash: hash(text), position: { line: 0, character: 1 } };
    const result = await refreshLspEnrichment(f.index, { enabled: true, approve, queries: [moved], cacheDir: f.cacheDir });
    expect(result.results).toHaveLength(1);
    expect(result.queries).toEqual([moved]);
    expect(result.diagnostics.some((d) => d.code === "stale-query")).toBe(true);
    const loaded = await loadLspEnrichment(f.index, { cacheDir: f.cacheDir });
    expect(loaded.queries).toEqual([moved]);
  });
});

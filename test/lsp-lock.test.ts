import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureLspEnrichment } from "../src/enrichment/enrichment.js";
import type { LspPolicy } from "../src/enrichment/types.js";
import { workspaceDirFor } from "../src/cache/cache.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const foreign = JSON.stringify({ pid: process.pid, host: os.hostname(), token: "00000000-0000-4000-8000-00000000abcd" });

async function takeOver(lock: string): Promise<void> {
  if ((await fs.lstat(lock)).isDirectory()) await fs.writeFile(path.join(lock, "owner.json"), foreign);
  else await fs.writeFile(lock, foreign);
}

async function held(lock: string): Promise<string | undefined> {
  const stat = await fs.lstat(lock).catch(() => undefined);
  if (stat === undefined) return undefined;
  return fs.readFile(stat.isDirectory() ? path.join(lock, "owner.json") : lock, "utf8");
}

describe("LSP enrichment writer lock", () => {
  it("does not delete a lock another writer took over while the operation ran", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-lsp-lock-"));
    dirs.push(dir);
    const root = path.join(dir, "workspace");
    const cacheDir = path.join(dir, "cache");
    await fs.mkdir(root);
    const policy: LspPolicy = { version: 1, servers: [{ id: "ts", workspace: root, languages: ["typescript"], executable: process.execPath }] };
    const lock = path.join(workspaceDirFor(cacheDir, root), "lsp", "writer.lock");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith("policy.json")) await takeOver(lock);
      return rename(from, to);
    });
    await expect(configureLspEnrichment(root, policy, { cacheDir })).rejects.toThrow();
    expect(await held(lock)).toBe(foreign);
  });
});

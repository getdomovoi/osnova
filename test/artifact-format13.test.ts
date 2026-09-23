import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { loadIndex } from "../src/api.js";
import { workspaceDirFor } from "../src/cache/cache.js";
import { sha256Hex } from "../src/index/scan.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-repo");
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function scratch(): Promise<string> { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-fmt13-")); dirs.push(dir); return dir; }

interface Core { files: Array<{ symbols: unknown[]; d: number[] }> }

async function tamper(mutate: (core: Core) => void): Promise<{ repo: string; cacheDir: string }> {
  const dir = await scratch(); const cacheDir = path.join(dir, "cache");
  const repo = path.join(dir, "repo");
  await fs.cp(FIXTURE, repo, { recursive: true });
  const index = await buildIndex(repo, { cacheDir });
  const ws = workspaceDirFor(cacheDir, index.root);
  const corePath = path.join(ws, "index.json");
  const core = JSON.parse((await fs.readFile(corePath)).toString("utf8")) as Core;
  mutate(core);
  const raw = Buffer.from(JSON.stringify(core), "utf8");
  await fs.writeFile(corePath, raw);
  await fs.writeFile(path.join(ws, "index.sha"), `${sha256Hex(raw)}\n`);
  return { repo, cacheDir };
}

describe("format 13 degree table", () => {
  it.each([
    ["a missing table", (core: Core) => { delete (core.files[0] as { d?: number[] }).d; }],
    ["a short table", (core: Core) => { core.files.find((f) => f.symbols.length > 0)!.d.pop(); }],
    ["a negative count", (core: Core) => { core.files.find((f) => f.symbols.length > 0)!.d[0] = -1; }],
    ["a fractional count", (core: Core) => { core.files.find((f) => f.symbols.length > 0)!.d[0] = 1.5; }],
  ])("rejects %s as cache-read-failed on the first body access", async (_name, mutate) => {
    const { repo, cacheDir } = await tamper(mutate);
    const index = (await loadIndex(repo, { cacheDir }))!;
    expect(() => index.files.size).toThrow(expect.objectContaining({ diagnostic: expect.objectContaining({ code: "cache-read-failed" }) }));
  });

  it("serves a tampered count rather than recounting, so the table is the artifact's word", async () => {
    const { repo, cacheDir } = await tamper((core) => { core.files.find((f) => f.symbols.length > 0)!.d[0] = 999; });
    const index = (await loadIndex(repo, { cacheDir }))!;
    const first = [...index.files.values()].find((f) => f.symbols.length > 0)!.symbols[0]!;
    expect(index.degree(first.qualifiedName).incoming).toBe(999);
  });
});

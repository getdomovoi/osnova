import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { runCli } from "../src/cli/cli.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";
import { workspaceDirFor } from "../src/cache/cache.js";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv }).trim();

let temporary: string;
let repo: string;
let cache: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-settle-ref-"));
  repo = path.join(temporary, "repo"); cache = path.join(temporary, "cache");
  await fs.mkdir(repo);
  git(repo, "init", "-q"); git(repo, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(repo, "api.ts"), "export function work() { return 1; }\n");
  await fs.writeFile(path.join(repo, "entry.ts"), "import { work } from './api.js';\nexport function start() { return work(); }\n");
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "base");
  await fs.writeFile(path.join(repo, "api.ts"), "export function work() { return 2; }\n");
  git(repo, "commit", "-q", "-am", "head");
});
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

async function settle(args: string[], workspace = repo) {
  const out: string[] = []; const err: string[] = [];
  const code = await runCli(["settle", ...args, "--workspace", workspace, "--cache-dir", cache], { stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
  return { code, text: out.join("\n"), stderr: err.join("\n") };
}

async function baseTrees(): Promise<string[]> {
  return (await fs.readdir(path.join(workspaceDirFor(cache, await fs.realpath(repo)), "base"))).filter((name) => /^[0-9a-f]{40}$/.test(name)).sort();
}

describe.skipIf(process.platform === "win32")("settle --base-ref", () => {
  it("materializes the base commit without a checkout and reports the dependents of the changed symbol", async () => {
    const base = git(repo, "rev-parse", "HEAD~1");
    const first = await settle(["--base-ref", "HEAD~1"]);
    expect(first.code).toBe(0);
    expect(first.text).toMatch(/1 symbol changes; [1-9]\d* dependents/);
    expect(first.text).toContain("changed: api.ts#work -> api.ts#work");
    expect(first.text).toContain("entry.ts#start");
    expect(first.text).not.toContain("base = current index");
    expect(first.stderr).toContain(`base HEAD~1 = ${base} built`);
    expect(git(repo, "rev-parse", "HEAD")).not.toBe(base);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(await baseTrees()).toEqual([base]);
    const second = await settle(["--base-ref", base]);
    expect(second.text).toBe(first.text);
    expect(second.stderr).toContain(`base ${base} = ${base} reused`);
    expect(await baseTrees()).toEqual([base]);
  });

  it("walks one level of dependents by default and deeper only when --depth asks", async () => {
    await fs.writeFile(path.join(repo, "outer.ts"), "import { start } from './entry.js';\nexport function outer() { return start(); }\n");
    git(repo, "add", "."); git(repo, "commit", "-q", "-m", "outer");
    await fs.writeFile(path.join(repo, "api.ts"), "export function work() { return 3; }\n");
    git(repo, "commit", "-q", "-am", "head2");
    const fallback = await settle(["--base-ref", "HEAD~1"]);
    expect(fallback.text).toContain("entry.ts#start");
    expect(fallback.text).not.toContain("outer.ts#outer");
    const deeper = await settle(["--base-ref", "HEAD~1", "--depth", "2"]);
    expect(deeper.text).toContain("outer.ts#outer");
  });

  it("sees uncommitted edits as part of the current side", async () => {
    await fs.writeFile(path.join(repo, "entry.ts"), "import { work } from './api.js';\nexport function start() { return work(); }\nexport function extra() { return start(); }\n");
    const result = await settle(["--base-ref", "HEAD"]);
    expect(result.text).toContain("added: <new> -> entry.ts#extra");
  });

  it("fails closed on an unknown ref", async () => {
    await expect(settle(["--base-ref", "no-such-ref"])).rejects.toThrow("osnova settle: unknown git ref: no-such-ref");
    await expect(settle(["--base-ref", "HEAD", "--base-cache", cache])).rejects.toThrow("osnova settle: use either --base-ref or --base-cache");
    await expect(settle([])).rejects.toThrow("osnova settle: --base-ref or --base-cache is required");
  });

  it("fails closed when the workspace is not a git repository", async () => {
    await fs.mkdir(path.join(temporary, "plain"));
    const plain = await fs.realpath(path.join(temporary, "plain"));
    await fs.writeFile(path.join(plain, "a.ts"), "export const a = 1;\n");
    await expect(settle(["--base-ref", "HEAD"], plain)).rejects.toThrow(`osnova settle: workspace is not a git repository: ${plain}`);
  });

  it("keeps at most two base trees per workspace and evicts the oldest", async () => {
    const shas = [git(repo, "rev-parse", "HEAD~1"), git(repo, "rev-parse", "HEAD")];
    await fs.writeFile(path.join(repo, "api.ts"), "export function work() { return 3; }\n");
    git(repo, "commit", "-q", "-am", "third");
    shas.push(git(repo, "rev-parse", "HEAD"));
    for (const sha of shas) expect((await settle(["--base-ref", sha])).code).toBe(0);
    expect(await baseTrees()).toEqual([shas[1]!, shas[2]!].sort());
    expect((await settle(["--base-ref", shas[1]!])).stderr).toContain("reused");
    expect(await baseTrees()).toEqual([shas[1]!, shas[2]!].sort());
  });

  it("round-trips baseRef over MCP", async () => {
    const { server } = createOsnovaMcpServer(repo, { cacheDir: cache });
    const client = new Client({ name: "osnova-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "osnova_settle", arguments: { baseRef: "HEAD~1" } });
      expect(result.isError, JSON.stringify(result)).toBeFalsy();
      const text = ((result as { content?: readonly ContentBlock[] }).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
      expect(text).toMatch(/osnova settle: 1 symbol changes; [1-9]\d* dependents/);
      expect(text).toContain("changed: api.ts#work -> api.ts#work");
      expect(text).toContain("entry.ts#start");
      expect(text).not.toContain("base = current index");
      const missing = await client.callTool({ name: "osnova_settle", arguments: {} });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing.content)).toContain("diff or baseRef");
      const unknown = await client.callTool({ name: "osnova_settle", arguments: { baseRef: "no-such-ref" } });
      expect(unknown.isError).toBe(true);
      expect(JSON.stringify(unknown.content)).toContain("unknown git ref: no-such-ref");
    } finally {
      await client.close();
    }
  });
});

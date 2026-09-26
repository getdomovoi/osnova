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

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv }).trim();

let temporary: string;
let repo: string;
let workspace: string;
let cache: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-settle-subdir-"));
  repo = path.join(temporary, "repo"); cache = path.join(temporary, "cache");
  workspace = path.join(repo, "packages", "lib");
  await fs.mkdir(workspace, { recursive: true });
  git(repo, "init", "-q"); git(repo, "config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(repo, "README.md"), "root\n");
  await fs.writeFile(path.join(workspace, "api.ts"), "export function work() { return 1; }\n");
  await fs.writeFile(path.join(workspace, "entry.ts"), "import { work } from './api.js';\nexport function start() { return work(); }\n");
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "base");
  await fs.writeFile(path.join(workspace, "api.ts"), "export function work() { return 2; }\n");
});
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

async function mcpSettle(args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const { server } = createOsnovaMcpServer(workspace, { cacheDir: cache });
  const client = new Client({ name: "osnova-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "osnova_settle", arguments: args });
    const text = ((result as { content?: readonly ContentBlock[] }).content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
    return { isError: result.isError === true, text };
  } finally {
    await client.close();
  }
}

describe.skipIf(process.platform === "win32")("settle in a workspace below the repository root", () => {
  it("builds the base tree from the workspace's own folder, so an unchanged symbol is not reported as added", async () => {
    const out: string[] = [];
    const code = await runCli(["settle", "--base-ref", "HEAD", "--workspace", workspace, "--cache-dir", cache], { stdout: (text) => out.push(text), stderr: () => {} });
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/^1 symbol changes; [1-9]\d* dependents/m);
    expect(text).toContain("changed: api.ts#work -> api.ts#work");
    expect(text).not.toContain("added:");
  });

  it("reads a diff whose paths start at the repository root, as git diff prints them", async () => {
    const diff = git(repo, "diff");
    expect(diff).toContain("packages/lib/api.ts");
    const result = await mcpSettle({ diff });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toMatch(/osnova settle: 1 symbol changes; [1-9]\d* dependents/);
    expect(result.text).toContain("changed: api.ts#work -> api.ts#work");
    expect(result.text).toContain("entry.ts#start");
  });

  it("says when diff files are not in the index instead of answering zero in silence", async () => {
    await fs.writeFile(path.join(repo, "README.md"), "root changed\n");
    const diff = git(repo, "diff", "--", "README.md");
    const result = await mcpSettle({ diff });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain("osnova settle: 0 symbol changes");
    expect(result.text).toMatch(/1 diff file not in the index/);
  });

  it("settles the uncommitted edits with no arguments, and points a wrong-hunk diff at that call", async () => {
    const none = await mcpSettle({});
    expect(none.isError, none.text).toBe(false);
    expect(none.text).toContain("changed: api.ts#work -> api.ts#work");
    expect(none.text).toContain("entry.ts#start");
    const summary = "diff --git a/api.ts b/api.ts\n--- a/api.ts\n+++ b/api.ts\n@@ -1,3 +1,3 @@\n-export function work() { return 1; }\n+export function work() { return 2; }\n" +
      "diff --git a/entry.ts b/entry.ts\n--- a/entry.ts\n+++ b/entry.ts\n@@ -2,1 +2,1 @@\n-export function start() { return work(); }\n+export function start() { return work() + 0; }\n";
    const wrong = await mcpSettle({ diff: summary });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain("pass the exact diff output");
    expect(wrong.text).toContain("call osnova_settle with no arguments");
  });

  it("reads a whole repository-root diff on one basis, so a root file never stands in for a workspace file", async () => {
    await fs.writeFile(path.join(repo, "entry.ts"), "// root\nexport function start() { return 0; }\n");
    git(repo, "add", "entry.ts"); git(repo, "commit", "-q", "-m", "root entry");
    await fs.writeFile(path.join(repo, "entry.ts"), "// root\nexport function start() { return 9; }\n");
    const diff = git(repo, "diff");
    expect(diff).toContain("a/entry.ts");
    const result = await mcpSettle({ diff });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain("changed: api.ts#work -> api.ts#work");
    expect(result.text).not.toContain("changed: entry.ts#start");
    expect(result.text).toContain("../../entry.ts");
  });

  it("refuses to guess when a repository-root path also names a workspace file", async () => {
    await fs.mkdir(path.join(workspace, "packages", "lib"), { recursive: true });
    await fs.writeFile(path.join(workspace, "packages", "lib", "api.ts"), "export function mirror() { return 1; }\n");
    git(repo, "add", "packages/lib/packages"); git(repo, "commit", "-q", "-m", "mirror");
    const diff = git(repo, "diff");
    expect(diff).toContain("a/packages/lib/api.ts");
    const result = await mcpSettle({ diff, baseRef: "HEAD" });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).not.toContain("mirror");
    expect(result.text).toMatch(/1 diff path names both a workspace file and a repository-root file, first packages\/lib\/api\.ts/);
  });

  it("never lets an unindexed path decide that a workspace-relative diff is read from the root", async () => {
    await fs.mkdir(path.join(workspace, "packages", "lib"), { recursive: true });
    await fs.writeFile(path.join(workspace, "packages", "lib", "api.ts"), "export function mirror() { return 1; }\n");
    await fs.mkdir(path.join(workspace, "packages", "lib", "node_modules"), { recursive: true });
    await fs.writeFile(path.join(workspace, "packages", "lib", "node_modules", "sentinel.ts"), "export const s = 1;\n");
    git(repo, "add", "-f", "packages/lib/packages"); git(repo, "commit", "-q", "-m", "mirror");
    git(repo, "checkout", "-q", "--", "packages/lib/api.ts");
    await fs.writeFile(path.join(workspace, "packages", "lib", "api.ts"), "export function mirror() { return 2; }\n");
    await fs.writeFile(path.join(workspace, "packages", "lib", "node_modules", "sentinel.ts"), "export const s = 2;\n");
    const diff = execFileSync("git", ["-C", workspace, "diff", "HEAD", "--relative", "--", "."], { encoding: "utf8", env: gitEnv });
    expect(diff).toContain("a/packages/lib/node_modules/sentinel.ts");
    const result = await mcpSettle({ diff, baseRef: "HEAD" });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).not.toContain("changed: api.ts#real");
    expect(result.text).not.toContain("changed: api.ts#work");
  });

  it("reports a root file as ambiguous when the only workspace path in the diff is one the index skips", async () => {
    await fs.writeFile(path.join(repo, "entry.ts"), "export function rootEntry() { return 0; }\n");
    await fs.mkdir(path.join(workspace, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(workspace, "node_modules", "sentinel.ts"), "export const s = 1;\n");
    git(repo, "add", "-f", "entry.ts", "packages/lib/node_modules"); git(repo, "commit", "-q", "-m", "root entry and sentinel");
    git(repo, "checkout", "-q", "--", "packages/lib/api.ts");
    await fs.writeFile(path.join(repo, "entry.ts"), "export function rootEntry() { return 9; }\n");
    await fs.writeFile(path.join(workspace, "node_modules", "sentinel.ts"), "export const s = 2;\n");
    const diff = git(repo, "diff");
    expect(diff).toContain("a/entry.ts");
    expect(diff).toContain("a/packages/lib/node_modules/sentinel.ts");
    const result = await mcpSettle({ diff, baseRef: "HEAD" });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).not.toContain("changed: entry.ts#start");
    expect(result.text).toMatch(/diff path names both a workspace file and a repository-root file, first entry\.ts/);
  });

  it("notes a rename from outside the workspace whose source the index does not hold", async () => {
    await fs.writeFile(path.join(repo, "moved.ts"), "export function moved() { return 1; }\n");
    git(repo, "add", "moved.ts"); git(repo, "commit", "-q", "-m", "root file");
    git(repo, "mv", "moved.ts", "packages/lib/moved.ts");
    const diff = git(repo, "diff", "HEAD", "-M");
    expect(diff).toContain("rename to packages/lib/moved.ts");
    const result = await mcpSettle({ diff, baseRef: "HEAD" });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain("../../moved.ts");
  });

  it("notes a rename whose destination the index does not hold", async () => {
    await fs.writeFile(path.join(workspace, ".gitignore"), "*.bin\n");
    git(repo, "add", "packages/lib/.gitignore"); git(repo, "commit", "-q", "-m", "ignore bin");
    git(repo, "mv", "packages/lib/entry.ts", "packages/lib/entry.bin");
    const diff = git(repo, "diff", "--cached", "-M");
    expect(diff).toContain("rename to packages/lib/entry.bin");
    const result = await mcpSettle({ diff, baseRef: "HEAD" });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toMatch(/diff file not in the index, first entry\.bin/);
  });
});

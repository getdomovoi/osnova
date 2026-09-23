import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const osnovaFromSource = `node --import ${pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href} ${path.join(root, "src", "cli", "bin.ts")}`;
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } }).trim();

describe.skipIf(process.platform === "win32")("settle-ci.sh", () => {
  it("indexes the base commit without a checkout and reports the dependents of the changed symbols", async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-settle-ci-"));
    const repo = path.join(temporary, "repo"); await fs.mkdir(repo);
    git(repo, "init", "-q"); git(repo, "config", "commit.gpgsign", "false");
    await fs.writeFile(path.join(repo, "api.ts"), "export function work() { return 1; }\n");
    await fs.writeFile(path.join(repo, "entry.ts"), "import { work } from './api.js';\nexport function start() { return work(); }\n");
    git(repo, "add", "."); git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    await fs.writeFile(path.join(repo, "api.ts"), "export function work() { return 2; }\n");
    git(repo, "commit", "-q", "-am", "head");
    const summary = path.join(temporary, "summary.md");
    const report = path.join(temporary, "report.txt");
    const output = execFileSync("bash", [path.join(root, "scripts", "settle-ci.sh")], {
      cwd: repo, encoding: "utf8",
      env: { ...process.env, OSNOVA: osnovaFromSource, BASE_REF: base, DEPTH: "1", RUNNER_TEMP: temporary, GITHUB_STEP_SUMMARY: summary, REPORT: report },
    });
    expect(output).toMatch(/1 symbol changes; [1-9]\d* dependents/);
    expect(output).toContain("entry.ts#start");
    expect(await fs.readFile(summary, "utf8")).toContain("## osnova settle");
    expect(git(repo, "rev-parse", "HEAD")).not.toBe(base);
    expect(git(repo, "status", "--porcelain")).toBe("");
    await fs.rm(temporary, { recursive: true, force: true });
  });
});

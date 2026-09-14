import { afterEach, beforeEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const gate = fileURLToPath(new URL("../scripts/git-gates.mjs", import.meta.url));
let root: string;
const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-gate-test-"));
  git(["init", "-q"]);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "gate-fixture", type: "module", scripts: {
    lint: "node check.mjs LINT_FAIL", typecheck: "node check.mjs TYPE_FAIL", build: "node check.mjs BUILD_FAIL", test: "node check.mjs TEST_FAIL",
  } }));
  await fs.writeFile(path.join(root, "check.mjs"), "import fs from 'node:fs'; if(fs.readFileSync('value.txt','utf8').includes(process.argv[2])) process.exit(1);\n");
  await fs.writeFile(path.join(root, "value.txt"), "good\n");
  git(["add", "."]);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it("rejects bad staged content even when the worktree is repaired", async () => {
  await fs.writeFile(path.join(root, "value.txt"), "LINT_FAIL\n");
  git(["add", "value.txt"]);
  await fs.writeFile(path.join(root, "value.txt"), "good\n");
  const before = git(["diff", "--cached", "--binary"]);
  const result = spawnSync(process.execPath, [gate, "commit"], { cwd: root, encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("lint failed");
  expect(git(["diff", "--cached", "--binary"])).toBe(before);
});

it("allows a good staged snapshot despite unrelated worktree edits", async () => {
  await fs.writeFile(path.join(root, "value.txt"), "LINT_FAIL\n");
  const result = spawnSync(process.execPath, [gate, "commit"], { cwd: root, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(await fs.readFile(path.join(root, "value.txt"), "utf8")).toBe("LINT_FAIL\n");
});

it("validates the pushed tree, including tests, rather than a clean worktree", async () => {
  await fs.writeFile(path.join(root, "value.txt"), "TEST_FAIL\n");
  git(["add", "value.txt"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  await fs.writeFile(path.join(root, "value.txt"), "good\n");
  const result = spawnSync(process.execPath, [gate, "push"], { cwd: root, encoding: "utf8", input: `refs/heads/test ${sha} refs/heads/test ${"0".repeat(40)}\n` });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("test failed");
});

it("treats a deletion as no code snapshot to validate", () => {
  const result = spawnSync(process.execPath, [gate, "push"], { cwd: root, encoding: "utf8", input: `(delete) ${"0".repeat(40)} refs/heads/test ${"a".repeat(40)}\n` });
  expect(result.status, result.stderr).toBe(0);
});

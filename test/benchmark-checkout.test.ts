import { afterEach, beforeEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runBenchmark } from "../scripts/bench/runner.js";
import { parseManifest } from "../scripts/bench/manifest.js";

const execute = promisify(execFile);
let root: string;
let revision: string;

async function git(args: string[]): Promise<string> {
  return (await execute("git", ["-C", root, ...args], { timeout: 10_000 })).stdout;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-checkout-fixture-"));
  await git(["init", "-q"]);
  await fs.writeFile(path.join(root, "one.ts"), "export function alpha() {}\n");
  await git(["add", "one.ts"]);
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]);
  revision = (await git(["rev-parse", "HEAD"])).trim();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function manifest(pin = revision) {
  return parseManifest({
    schemaVersion: 1, id: "checkout-test", source: { kind: "checkout", revision: pin },
    edit: { file: "one.ts", append: "\n// changed in copy only\n" },
    cases: [{ id: "alpha", kind: "ask", split: "development", question: "alpha", expected: ["one.ts#alpha"],
      anchors: [{ file: "one.ts", text: "function alpha" }] }],
  });
}

it("benchmarks a verified checkout without changing its files or refs", async () => {
  const before = await fs.readFile(path.join(root, "one.ts"));
  const report = await runBenchmark(manifest(), { samples: 1, split: "development", workspace: root });
  expect(report.status).toBe("completed");
  expect(report.sourceRevision).toBe(revision);
  expect(report.cases[0]?.ranking?.recall).toBe(1);
  expect(await fs.readFile(path.join(root, "one.ts"))).toEqual(before);
  expect((await git(["rev-parse", "HEAD"])).trim()).toBe(revision);
  expect(await git(["status", "--porcelain"])).toBe("");
});

it("rejects a revision mismatch rather than measuring the wrong code", async () => {
  const report = await runBenchmark(manifest("a".repeat(40)), { samples: 1, split: "development", workspace: root });
  expect(report.status).toBe("failed");
  expect(report.errors.join("\n")).toContain("revision mismatch");
  expect(report.cases[0]?.status).toBe("error");
});

it("rejects untracked source instead of letting it contaminate a pinned workload", async () => {
  await fs.writeFile(path.join(root, "untracked.ts"), "export function beta() {}\n");
  const report = await runBenchmark(manifest(), { samples: 1, split: "development", workspace: root });
  expect(report.status).toBe("failed");
  expect(report.errors.join("\n")).toContain("checkout must be clean");
  expect(await fs.readFile(path.join(root, "untracked.ts"), "utf8")).toContain("beta");
});

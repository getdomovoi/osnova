import { afterEach, beforeEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("../scripts/extraction-version-guard.mjs", import.meta.url));
const versionLine = (value: string) => `export const extractionVersion = \`${value}.queries-\${queriesFingerprint}\`;\n`;
let root: string;
const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });

async function put(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), content);
}

function commit(message: string): void {
  git(["add", "-A"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message]);
}

function run(): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, [guard, "base"], { cwd: root, encoding: "utf8" });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-extraction-guard-"));
  git(["init", "-q"]);
  await put("src/index/serialize.ts", versionLine("structural-1.scan-1"));
  await put("src/extract/bindings.ts", "export const a = 1;\n");
  await put("src/grammar/queries/typescript.ts", "export const q = '';\n");
  await put("src/index/scan.ts", "export const s = 1;\n");
  await put("src/query/ask.ts", "export const k = 1;\n");
  commit("base");
  git(["branch", "base"]);
});

afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it("fails when extraction code changes and the version does not", async () => {
  await put("src/extract/bindings.ts", "export const a = 2;\n");
  commit("change extraction");
  const result = run();
  expect(result.status).toBe(1);
  expect(result.out).toContain("src/extract/bindings.ts");
  expect(result.out).toContain("extractionVersion");
});

it("fails for a scan change too, since scan output is part of the cached artifact", async () => {
  await put("src/index/scan.ts", "export const s = 2;\n");
  commit("change scan");
  const result = run();
  expect(result.status).toBe(1);
  expect(result.out).toContain("src/index/scan.ts");
});

it("passes when the version moves with the extraction change", async () => {
  await put("src/extract/bindings.ts", "export const a = 2;\n");
  await put("src/index/serialize.ts", versionLine("structural-2.scan-1"));
  commit("change extraction and bump");
  expect(run().status).toBe(0);
});

it("passes a query change, which the queries fingerprint already covers", async () => {
  await put("src/grammar/queries/typescript.ts", "export const q = 'x';\n");
  commit("change query");
  expect(run().status).toBe(0);
});

it("passes a change that touches no extraction input", async () => {
  await put("src/query/ask.ts", "export const k = 2;\n");
  commit("change query layer");
  expect(run().status).toBe(0);
});

it("does not count an edit elsewhere in serialize.ts as a bump", async () => {
  await put("src/extract/bindings.ts", "export const a = 2;\n");
  await put("src/index/serialize.ts", `${versionLine("structural-1.scan-1")}// unrelated\n`);
  commit("change extraction and an unrelated serialize line");
  const result = run();
  expect(result.status).toBe(1);
  expect(result.out).toContain("extractionVersion is unchanged");
});

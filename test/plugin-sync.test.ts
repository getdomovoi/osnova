import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "sync-claude-plugin.sh");
const pluginDir = path.join(root, "integrations", "claude-code");

const listFiles = (dir: string): Record<string, string> => {
  const files: Record<string, string> = {};
  for (const rel of fs.readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (rel === ".git" || rel.startsWith(`.git${path.sep}`)) continue;
    const full = path.join(dir, rel);
    if (fs.statSync(full).isFile()) files[rel.split(path.sep).join("/")] = fs.readFileSync(full).toString("base64");
  }
  return files;
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("claude plugin repository sync", () => {
  it("makes the checkout hold exactly the plugin folder, LICENSE and NOTICE, keeping its git data", () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-plugin-sync-"));
    temps.push(dest);
    execFileSync("git", ["init", "-q", dest]);
    fs.mkdirSync(path.join(dest, "hooks"));
    fs.writeFileSync(path.join(dest, "hooks", "stale.json"), "{}");
    fs.writeFileSync(path.join(dest, "pnpm-workspace.yaml"), "allowBuilds: {}\n");

    execFileSync("sh", [script, dest]);

    const expected = listFiles(pluginDir);
    expected.LICENSE = fs.readFileSync(path.join(root, "LICENSE")).toString("base64");
    expected.NOTICE = fs.readFileSync(path.join(root, "NOTICE")).toString("base64");
    expect(listFiles(dest)).toEqual(expected);
    expect(fs.existsSync(path.join(dest, ".git", "HEAD"))).toBe(true);
  });

  it("refuses a target that is not a git checkout", () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-plugin-sync-"));
    temps.push(dest);
    fs.writeFileSync(path.join(dest, "keep.txt"), "x");
    expect(() => execFileSync("sh", [script, dest], { stdio: "pipe" })).toThrow();
    expect(fs.existsSync(path.join(dest, "keep.txt"))).toBe(true);
  });
});

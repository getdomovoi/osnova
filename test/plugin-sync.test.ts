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

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdio: "pipe" });

// A committed checkout whose origin is the plugin repository, holding the given files.
const pluginCheckout = (files: Record<string, string>, origin = "git@github.com:getdomovoi/osnova-claude-plugin.git"): string => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-plugin-sync-"));
  temps.push(dest);
  git(dest, "init", "-q");
  git(dest, "remote", "add", "origin", origin);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.writeFileSync(path.join(dest, rel), text);
  }
  git(dest, "add", "-A");
  git(dest, "commit", "-q", "--allow-empty", "-m", "seed");
  return dest;
};

const sync = (dest: string) => execFileSync("sh", [script, dest], { stdio: "pipe" });

describe.skipIf(process.platform === "win32")("claude plugin repository sync", () => {
  it("makes the checkout hold exactly the plugin folder, LICENSE and NOTICE, keeping its git data", () => {
    const dest = pluginCheckout({ "hooks/stale.json": "{}", "pnpm-workspace.yaml": "allowBuilds: {}\n" });

    sync(dest);

    const expected = listFiles(pluginDir);
    expected.LICENSE = fs.readFileSync(path.join(root, "LICENSE")).toString("base64");
    expected.NOTICE = fs.readFileSync(path.join(root, "NOTICE")).toString("base64");
    expect(listFiles(dest)).toEqual(expected);
    expect(fs.existsSync(path.join(dest, ".git", "HEAD"))).toBe(true);
  });

  it("accepts the HTTPS form of the plugin repository's origin", () => {
    const dest = pluginCheckout({}, "https://github.com/getdomovoi/osnova-claude-plugin");
    sync(dest);
    expect(fs.existsSync(path.join(dest, "LICENSE"))).toBe(true);
  });

  it("refuses a target that is not a git checkout", () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-plugin-sync-"));
    temps.push(dest);
    fs.writeFileSync(path.join(dest, "keep.txt"), "x");
    expect(() => sync(dest)).toThrow();
    expect(fs.existsSync(path.join(dest, "keep.txt"))).toBe(true);
  });

  it("refuses a checkout of another repository", () => {
    const dest = pluginCheckout({ "keep.txt": "x" }, "git@github.com:getdomovoi/osnova.git");
    expect(() => sync(dest)).toThrow(/not a checkout of getdomovoi\/osnova-claude-plugin/);
    expect(fs.existsSync(path.join(dest, "keep.txt"))).toBe(true);
  });

  it("refuses a checkout with uncommitted changes", () => {
    const dest = pluginCheckout({ "keep.txt": "x" });
    fs.writeFileSync(path.join(dest, "draft.txt"), "unsaved");
    expect(() => sync(dest)).toThrow(/uncommitted changes/);
    expect(fs.readFileSync(path.join(dest, "draft.txt"), "utf8")).toBe("unsaved");
  });

  it("refuses a checkout with an ignored file, which a plain status hides", () => {
    const dest = pluginCheckout({ ".gitignore": ".env\n" });
    fs.writeFileSync(path.join(dest, ".env"), "SECRET=1");
    expect(() => sync(dest)).toThrow(/uncommitted changes/);
    expect(fs.readFileSync(path.join(dest, ".env"), "utf8")).toBe("SECRET=1");
  });

  it("refuses an untracked file even when the checkout hides untracked files", () => {
    const dest = pluginCheckout({ "keep.txt": "x" });
    git(dest, "config", "status.showUntrackedFiles", "no");
    fs.writeFileSync(path.join(dest, "draft.txt"), "unsaved");
    expect(() => sync(dest)).toThrow(/uncommitted changes/);
    expect(fs.readFileSync(path.join(dest, "draft.txt"), "utf8")).toBe("unsaved");
  });

  it("refuses this repository", () => {
    expect(() => sync(root)).toThrow();
  });
});

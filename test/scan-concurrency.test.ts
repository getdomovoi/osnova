import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanFiles } from "../src/index/scan.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

async function repo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-scan-"));
  dirs.push(root);
  for (let d = 0; d < 20; d += 1) {
    const dir = path.join(root, `pkg${d}`, "src");
    await fs.mkdir(dir, { recursive: true });
    for (let f = 0; f < 10; f += 1) await fs.writeFile(path.join(dir, `f${f}.ts`), `export const v${f} = ${f};\n`);
    if (d % 3 === 0) await fs.writeFile(path.join(root, `pkg${d}`, ".gitignore"), "src/f9.ts\n");
  }
  return root;
}

describe("scan", () => {
  it("returns sorted paths and honors nested ignore files", async () => {
    const root = await repo();
    const result = await scanFiles(root);
    expect(result.paths).toEqual([...result.paths].sort());
    expect(result.paths).toContain("pkg1/src/f9.ts");
    expect(result.paths).not.toContain("pkg0/src/f9.ts");
    expect(result.paths).toHaveLength(20 * 10 - 7);
  });

  it("rejects a symlinked directory and a symlinked ignore file", async () => {
    const root = await repo();
    await fs.symlink(path.join(root, "pkg1"), path.join(root, "linked"));
    await expect(scanFiles(root)).rejects.toMatchObject({ diagnostic: { code: "symlink-not-indexed" } });
    await fs.rm(path.join(root, "linked"));
    await fs.writeFile(path.join(root, "real-ignore"), "");
    await fs.symlink(path.join(root, "real-ignore"), path.join(root, "pkg2", ".gitignore"));
    await expect(scanFiles(root)).rejects.toMatchObject({ diagnostic: { code: "ignore-unreadable" } });
  });

  it("names the same unreadable path on every run", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = await repo();
    await fs.chmod(path.join(root, "pkg5", "src"), 0o000);
    await fs.chmod(path.join(root, "pkg3", "src"), 0o000);
    try {
      for (let i = 0; i < 3; i += 1) {
        await expect(scanFiles(root)).rejects.toMatchObject({ diagnostic: { code: "directory-unreadable", path: "pkg3/src" } });
      }
    } finally {
      await fs.chmod(path.join(root, "pkg5", "src"), 0o755);
      await fs.chmod(path.join(root, "pkg3", "src"), 0o755);
    }
  });

  it("bounds concurrent ignore-file reads to the directory gate", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-scan-ignore-"));
    dirs.push(root);
    for (let d = 0; d < 40; d += 1) {
      const dir = path.join(root, `dir${d}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, ".gitignore"), "*.log\n");
    }
    const originalReadFile = fs.readFile.bind(fs);
    let active = 0;
    let max = 0;
    const spy = vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      active += 1;
      max = Math.max(max, active);
      try {
        return await originalReadFile(...args);
      } finally {
        active -= 1;
      }
    });
    try {
      await scanFiles(root);
    } finally {
      spy.mockRestore();
    }
    expect(max).toBeLessThanOrEqual(8);
  });

  it("surfaces a permission failure resolving a symlink target as stat-failed", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-scan-symstat-"));
    dirs.push(root);
    await fs.mkdir(path.join(root, ".blocked", "inner"), { recursive: true });
    await fs.symlink(path.join(root, ".blocked", "inner"), path.join(root, "link"));
    await fs.chmod(path.join(root, ".blocked"), 0o000);
    try {
      await expect(scanFiles(root)).rejects.toMatchObject({ diagnostic: { code: "stat-failed", path: "link" } });
    } finally {
      await fs.chmod(path.join(root, ".blocked"), 0o755);
    }
  });
});

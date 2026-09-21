import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const mode = process.argv[2];
if (mode !== "commit" && mode !== "push") throw new Error("gate mode must be commit or push");
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const trees = new Set();
if (mode === "commit") {
  trees.add(execFileSync("git", ["write-tree"], { encoding: "utf8" }).trim());
} else {
  for (const line of readFileSync(0, "utf8").split("\n").filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !/^[a-f0-9]{40,64}$/.test(fields[1] ?? "")) throw new Error("invalid pre-push ref input");
    if (/^0+$/.test(fields[1])) continue;
    trees.add(execFileSync("git", ["rev-parse", `${fields[1]}^{tree}`], { encoding: "utf8" }).trim());
  }
}

const gateEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));

for (const tree of trees) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-gate-"));
  try {
    const archive = execFileSync("git", ["archive", "--format=tar", tree], { maxBuffer: 128 * 1024 * 1024 });
    const unpack = spawnSync("tar", ["-xf", "-", "-C", temporary], { input: archive });
    if (unpack.status !== 0 || unpack.error) throw new Error(`snapshot extraction failed: ${unpack.error?.message ?? unpack.stderr?.toString()}`);
    const modules = path.join(root, "node_modules");
    try {
      if ((await fs.stat(modules)).isDirectory()) await fs.symlink(modules, path.join(temporary, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const gate of mode === "commit" ? ["lint", "typecheck"] : ["lint", "typecheck", "build", "test"]) {
      process.stdout.write(`osnova: ${gate} on ${mode === "commit" ? "staged snapshot" : "pushed snapshot"} ${tree.slice(0, 8)}\n`);
      const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", gate], { cwd: temporary, env: gateEnv, stdio: "inherit", shell: process.platform === "win32" });
      if (result.error || result.status !== 0) throw new Error(`${gate} failed; ${mode} blocked${result.error ? `: ${result.error.message}` : ""}`);
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

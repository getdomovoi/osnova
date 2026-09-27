import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { buildIndex } from "./build.js";
import { loadArtifact } from "./serialize.js";
import { canonicalWorkspaceRoot } from "./workspace.js";
import { resolveCacheDir, workspaceDirFor } from "../cache/cache.js";
import { withCacheLock } from "../cache/lock.js";
import type { OsnovaIndex } from "../types.js";

const execFileAsync = promisify(execFile);
const SHA_RE = /^[0-9a-f]{40}$/;
const maximumDiffBytes = 64 * 1024 * 1024;

export const maximumBaseTrees = 2;

export interface BaseTree {
  readonly index: OsnovaIndex;
  readonly ref: string;
  readonly sha: string;
  readonly dir: string;
  readonly reused: boolean;
}

interface GitError extends NodeJS.ErrnoException { stderr?: string }

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE;
  return env;
}

async function git(root: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: maximumDiffBytes, env: gitEnvironment() });
    return stdout;
  } catch (error) {
    const failure = error as GitError;
    if (failure.code === "ENOENT") throw new Error("osnova settle: git is not available on PATH");
    if (/not a git repository/i.test(failure.stderr ?? "")) throw new Error(`osnova settle: workspace is not a git repository: ${root}`);
    throw error;
  }
}

async function gitTopAndPrefix(root: string): Promise<{ top: string; prefix: string }> {
  const top = await fs.realpath((await git(root, ["rev-parse", "--show-toplevel"])).trim());
  const prefix = path.relative(top, root).split(path.sep).join("/");
  if (prefix.startsWith("..")) throw new Error(`osnova settle: workspace is not a git repository: ${root}`);
  return { top, prefix };
}

export async function workspaceGitPrefix(root: string): Promise<string> {
  try {
    return (await gitTopAndPrefix(await fs.realpath(root))).prefix;
  } catch {
    return "";
  }
}

export async function resolveGitRef(root: string, ref: string): Promise<{ sha: string; prefix: string; top: string }> {
  if (ref.length === 0 || ref.startsWith("-")) throw new Error(`osnova settle: invalid git ref: ${ref}`);
  const { top, prefix } = await gitTopAndPrefix(root);
  const sha = (await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch((error: Error) => {
    if (error.message.startsWith("osnova settle:")) throw error;
    return "";
  })).trim();
  if (!SHA_RE.test(sha)) throw new Error(`osnova settle: unknown git ref: ${ref}`);
  return { sha, prefix, top };
}

export async function baseDiff(root: string, sha: string): Promise<string> {
  return git(root, ["-c", "core.quotePath=false", "diff", sha, "--relative", "--no-color", "--no-ext-diff", "--", "."]);
}

async function readAccess(dir: string): Promise<number> {
  try {
    const value = Number(await fs.readFile(path.join(dir, "access"), "utf8"));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function listBaseTrees(baseRoot: string): Promise<{ name: string; dir: string; access: number }[]> {
  let entries;
  try {
    entries = await fs.readdir(baseRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const trees = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SHA_RE.test(entry.name)) continue;
    const dir = path.join(baseRoot, entry.name);
    trees.push({ name: entry.name, dir, access: await readAccess(dir) });
  }
  return trees.sort((a, b) => a.access - b.access || (a.name < b.name ? -1 : 1));
}

async function extractTree(top: string, sha: string, prefix: string, tree: string): Promise<void> {
  await fs.mkdir(tree, { recursive: true });
  const archive = `${tree}.tar`;
  try {
    await git(top, ["archive", "--format=tar", "-o", archive, prefix.length === 0 ? sha : `${sha}:${prefix}`]);
    try {
      await execFileAsync("tar", ["-xf", archive, "-C", tree], { encoding: "utf8" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("osnova settle: tar is not available on PATH");
      throw error;
    }
  } finally {
    await fs.rm(archive, { force: true });
  }
}

export async function materializeBaseRef(workspace: string, ref: string, options: { cacheDir?: string | undefined } = {}): Promise<BaseTree> {
  const root = await canonicalWorkspaceRoot(workspace);
  const cacheDir = resolveCacheDir(options.cacheDir);
  const { sha, prefix, top } = await resolveGitRef(root, ref);
  const baseRoot = path.join(workspaceDirFor(cacheDir, root), "base");
  await fs.mkdir(baseRoot, { recursive: true });
  return withCacheLock(path.join(baseRoot, ".lock"), async () => {
    const dir = path.join(baseRoot, sha);
    const tree = path.join(dir, "tree"), treeCache = path.join(dir, "cache");
    let index: OsnovaIndex | undefined;
    let reused = false;
    try {
      index = await loadArtifact(tree, treeCache);
      reused = index !== undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (index === undefined) {
      await fs.rm(dir, { recursive: true, force: true });
      const staging = path.join(baseRoot, `${sha}.tmp-${randomUUID()}`);
      try {
        await extractTree(top, sha, prefix, path.join(staging, "tree"));
        await fs.rename(staging, dir);
        index = await buildIndex(tree, { cacheDir: treeCache });
      } catch (error) {
        await fs.rm(staging, { recursive: true, force: true });
        await fs.rm(dir, { recursive: true, force: true });
        throw error;
      }
    }
    const trees = await listBaseTrees(baseRoot);
    const latest = trees.reduce((max, item) => Math.max(max, item.access), 0) + 1;
    await fs.writeFile(path.join(dir, "access"), String(latest));
    for (const victim of trees.filter((item) => item.name !== sha).slice(0, Math.max(0, trees.length - maximumBaseTrees))) {
      await fs.rm(victim.dir, { recursive: true, force: true });
    }
    return { index, ref, sha, dir, reused };
  });
}

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { workspaceDirFor } from "./cache.js";
import { workspaceIdentity } from "../index/workspace.js";

const execFileAsync = promisify(execFile);
const familyVersion = 1;
const WORKSPACE_KEY_RE = /^[0-9a-f]{16}$/;

export interface FamilySidecar {
  readonly family: string | undefined;
  readonly root: string;
}

export interface FamilySibling {
  readonly dir: string;
  readonly root: string;
  readonly access: number;
}

export function seedingEnabled(options: { readonly seedFromSiblings?: boolean | undefined } = {}): boolean {
  if (options.seedFromSiblings === false) return false;
  const env = process.env.OSNOVA_CACHE_SEED;
  return env === undefined || !["0", "false", "off", "no"].includes(env.trim().toLowerCase());
}

export async function workspaceFamily(root: string): Promise<string | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd: root, encoding: "utf8", timeout: 5_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }));
  } catch {
    return undefined;
  }
  const [toplevel, common] = stdout.split(/\r?\n/);
  if (toplevel === undefined || toplevel === "" || common === undefined || common === "") return undefined;
  try {
    const [rootReal, topReal] = await Promise.all([fs.realpath(root), fs.realpath(toplevel)]);
    if (rootReal !== topReal) return undefined;
    const commonDir = await fs.realpath(path.resolve(rootReal, common));
    if (!(await fs.stat(commonDir)).isDirectory()) return undefined;
    return commonDir;
  } catch {
    return undefined;
  }
}

function familyPath(cacheDir: string, root: string): string {
  return path.join(workspaceDirFor(cacheDir, root), "family.json");
}

function parseSidecar(text: string): FamilySidecar | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const parsed = value as Record<string, unknown>;
  if (parsed.version !== familyVersion || typeof parsed.root !== "string" || !path.isAbsolute(parsed.root)) return undefined;
  if (parsed.family !== null && (typeof parsed.family !== "string" || !path.isAbsolute(parsed.family))) return undefined;
  return { family: parsed.family === null ? undefined : parsed.family, root: parsed.root };
}

export async function loadFamily(cacheDir: string, root: string): Promise<FamilySidecar | undefined> {
  try {
    return parseSidecar(await fs.readFile(familyPath(cacheDir, root), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveFamily(cacheDir: string, root: string, family: string | undefined): Promise<void> {
  const target = familyPath(cacheDir, root);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const content = JSON.stringify({ version: familyVersion, family: family ?? null, root });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function familySiblings(cacheDir: string, root: string, family: string): Promise<FamilySibling[]> {
  const own = workspaceDirFor(cacheDir, root);
  const ownRoot = workspaceIdentity(root);
  let entries;
  try {
    entries = await fs.readdir(cacheDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const siblings: FamilySibling[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !WORKSPACE_KEY_RE.test(entry.name)) continue;
    const dir = path.join(cacheDir, entry.name);
    if (dir === own) continue;
    let sidecar: FamilySidecar | undefined;
    try {
      sidecar = parseSidecar(await fs.readFile(path.join(dir, "family.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    if (sidecar === undefined || sidecar.family !== family || sidecar.root === ownRoot) continue;
    if (workspaceDirFor(cacheDir, sidecar.root) !== dir) continue;
    let access = 0;
    try {
      const value = Number(await fs.readFile(path.join(dir, "access"), "utf8"));
      if (Number.isSafeInteger(value) && value > 0) access = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    siblings.push({ dir, root: sidecar.root, access });
  }
  siblings.sort((a, b) => b.access - a.access || (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
  return siblings;
}

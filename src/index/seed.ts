import { promises as fs } from "node:fs";
import path from "node:path";
import { familySiblings, loadFamily, saveFamily, seedingEnabled, workspaceFamily } from "../cache/family.js";
import { CacheLockTimeoutError } from "../cache/lock.js";
import type { LockOptions } from "../cache/lock.js";
import { seedArtifactFrom } from "./serialize.js";
import { loadVerification } from "./verification.js";
import type { WorkspaceOptions } from "./workspace.js";
import type { OsnovaIndex, ProgressEvent } from "../types.js";

export interface SeedOutcome {
  readonly family: string | undefined;
  readonly index?: OsnovaIndex | undefined;
  readonly sibling?: string | undefined;
}

export async function seedWorkspace(absRoot: string, cacheDir: string, options: WorkspaceOptions & LockOptions = {}): Promise<SeedOutcome> {
  const family = await workspaceFamily(absRoot);
  if (family === undefined || !seedingEnabled(options)) return { family };
  for (const sibling of await familySiblings(cacheDir, absRoot, family)) {
    let generation: string;
    try {
      generation = (await fs.readFile(path.join(sibling.dir, "index.sha"), "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!/^[a-f0-9]{64}$/.test(generation) || (await loadVerification(cacheDir, sibling.root, generation)) === undefined) continue;
    try {
      const seeded = await seedArtifactFrom(cacheDir, sibling.root, absRoot, options);
      if (seeded === undefined || seeded.generation !== generation) continue;
      return { family, index: seeded.index, sibling: sibling.root };
    } catch (error) {
      if (error instanceof CacheLockTimeoutError) continue;
      throw error;
    }
  }
  return { family };
}

export function seedProgress(sibling: string, total: number, report: { readonly changed: readonly string[]; readonly deleted: readonly string[] }): ProgressEvent {
  return { phase: "seed", done: total - report.changed.length - report.deleted.length, total, sibling };
}

export async function ensureFamilySidecar(cacheDir: string, root: string, family: string | undefined, resolved: boolean): Promise<void> {
  if ((await loadFamily(cacheDir, root)) !== undefined) return;
  await saveFamily(cacheDir, root, resolved ? family : await workspaceFamily(root));
}

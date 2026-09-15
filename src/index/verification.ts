import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { workspaceDirFor } from "../cache/cache.js";
import type { FileMetadata } from "./scan.js";

const verificationVersion = 1;

export interface VerificationState {
  readonly generation: string;
  readonly files: ReadonlyMap<string, FileMetadata>;
}

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validMetadata(value: unknown): value is FileMetadata {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return Number.isSafeInteger(item.size) && (item.size as number) >= 0 &&
    ["mtimeNs", "ctimeNs", "ino", "dev"].every((key) => typeof item[key] === "string" && /^\d+$/.test(item[key] as string));
}

export async function loadVerification(cacheDir: string, root: string, generation: string): Promise<VerificationState | undefined> {
  const file = path.join(workspaceDirFor(cacheDir, root), "verification.json");
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    const payload = { version: parsed.version, generation: parsed.generation, files: parsed.files };
    if (parsed.version !== verificationVersion || parsed.generation !== generation || parsed.checksum !== checksum(payload) ||
      typeof parsed.files !== "object" || parsed.files === null || Array.isArray(parsed.files)) return undefined;
    const entries = Object.entries(parsed.files as Record<string, unknown>);
    if (!entries.every(([name, metadata]) => name.length > 0 && validMetadata(metadata))) return undefined;
    return { generation, files: new Map(entries as Array<[string, FileMetadata]>) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function saveVerification(cacheDir: string, root: string, generation: string, files: ReadonlyMap<string, FileMetadata>): Promise<void> {
  const dir = workspaceDirFor(cacheDir, root);
  await fs.mkdir(dir, { recursive: true });
  const ordered = Object.fromEntries([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const payload = { version: verificationVersion, generation, files: ordered };
  const content = JSON.stringify({ ...payload, checksum: checksum(payload) });
  const target = path.join(dir, "verification.json");
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

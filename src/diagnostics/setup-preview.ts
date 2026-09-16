import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

export interface SetupPreviewOptions {
  readonly cliPath: string;
  readonly executable?: string | undefined;
}

export interface SetupFileChange {
  readonly path: string;
  readonly action: "create" | "replace" | "unchanged" | "conflict";
  readonly content: string;
  readonly ownership: "osnova/setup@1";
  readonly beforeHash?: string | undefined;
  readonly conflict?: string | undefined;
}

export interface SetupPreview {
  readonly mode: "preview";
  readonly canApply: boolean;
  readonly changes: readonly SetupFileChange[];
  readonly notices: readonly string[];
}

export async function previewSetup(workspace: string, options: SetupPreviewOptions): Promise<SetupPreview> {
  if (!path.isAbsolute(options.cliPath) || !path.isAbsolute(options.executable ?? process.execPath)) {
    throw new TypeError("Setup preview requires absolute CLI and executable paths.");
  }
  const root = path.resolve(workspace);
  const target = path.join(root, ".osnova", "mcp.json");
  const content = JSON.stringify({
    _osnova: { owner: "osnova/setup", version: 1 },
    mcpServers: { osnova: { command: options.executable ?? process.execPath, args: [options.cliPath, "mcp", "--workspace", root] } },
  }, null, 2) + "\n";
  let action: SetupFileChange["action"] = "create";
  let conflict: string | undefined;
  let beforeHash: string | undefined;
  try {
    if (!(await lstat(root)).isDirectory()) {
      throw new Error("Workspace must be an existing directory, not a symlink.");
    }
    try {
      const parent = await lstat(path.dirname(target));
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Setup directory is not a plain directory.");
      try {
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Setup target is not a private regular file.");
        if (info.size > 65_536) throw new Error("Existing setup file exceeds the inspection limit.");
        const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let existing: string;
        try {
          const opened = await file.stat();
          if (!opened.isFile() || opened.nlink !== 1 || opened.size > 65_536) throw new Error("Setup target changed during inspection.");
          const buffer = Buffer.alloc(65_537);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 65_536) throw new Error("Existing setup file exceeds the inspection limit.");
          existing = buffer.subarray(0, bytesRead).toString("utf8");
        } finally {
          await file.close();
        }
        let parsed: unknown;
        try { parsed = JSON.parse(existing); } catch { throw new Error("Existing setup file is not valid owned JSON."); }
        if (!isOwnedConfig(parsed)) throw new Error("Existing setup file is unowned or contains unmanaged fields.");
        beforeHash = createHash("sha256").update(existing).digest("hex");
        action = existing === content ? "unchanged" : "replace";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch (error) {
    action = "conflict";
    conflict = error instanceof Error && !("code" in error) ? error.message : "Workspace or setup destination is inaccessible.";
  }
  return {
    mode: "preview", canApply: action !== "conflict",
    changes: [{ path: target, action, content, ownership: "osnova/setup@1", beforeHash, conflict }],
    notices: [
      "Preview only: no files written and no commands launched. No global configuration inspected or changed.",
      "This local MCP configuration is an inspectable template; nothing automatically loads it.",
      "CLI and executable paths are intended launch arguments, not an availability check.",
      "No apply operation is provided. Any future apply must recheck ownership and baseline hash, require explicit consent, and retain a rollback copy.",
    ],
  };
}

function isOwnedConfig(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  if (Object.keys(config).sort().join(",") !== "_osnova,mcpServers") return false;
  const marker = config._osnova as Record<string, unknown> | undefined;
  if (!marker || Object.keys(marker).sort().join(",") !== "owner,version" || marker.owner !== "osnova/setup" || marker.version !== 1) return false;
  const servers = config.mcpServers as Record<string, unknown> | undefined;
  if (!servers || Object.keys(servers).join(",") !== "osnova") return false;
  const server = servers.osnova as Record<string, unknown> | undefined;
  return !!server && Object.keys(server).sort().join(",") === "args,command" && typeof server.command === "string"
    && Array.isArray(server.args) && server.args.length === 4 && server.args.every((arg: unknown) => typeof arg === "string")
    && server.args[1] === "mcp" && server.args[2] === "--workspace";
}

import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const seen = vi.hoisted(() => [] as { lockTimeoutMs?: number | undefined }[]);
vi.mock("../src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api.js")>();
  return { ...actual, refreshWorkspace: (root: string, options: Parameters<typeof actual.refreshWorkspace>[1]) => { seen.push(options ?? {}); return actual.refreshWorkspace(root, options); } };
});

import { createOsnovaMcpServer } from "../src/mcp/server.js";

const temporaries: string[] = [];
afterEach(async () => { for (const dir of temporaries.splice(0)) await fs.rm(dir, { recursive: true, force: true }); seen.length = 0; });

// A session hook starts a cold build in the background; on a large repository it holds the build lock for longer than
// the default ten-second wait, and the MCP server's first calls failed with cache-lock-timeout. The server waits longer.
it("waits for a live build that another osnova process started", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-mcp-cold-"));
  temporaries.push(temporary);
  const workspace = path.join(temporary, "ws");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "a.ts"), "export function first() { return 1; }\n");
  const server = createOsnovaMcpServer(workspace, { cacheDir: path.join(temporary, "cache") });
  await server.refresh();
  server.close();
  expect(seen[0]?.lockTimeoutMs).toBeGreaterThanOrEqual(60_000);
});

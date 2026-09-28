import path from "node:path";
import { expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as unknown[]);
vi.mock("../src/mcp/server.js", () => ({ runMcpStdio: async (...args: unknown[]) => { calls.push(args); } }));

import { runCli } from "../src/cli/cli.js";

const io = { stdout: () => {}, stderr: () => {} };

it("passes --no-prewarm to the MCP server and leaves prewarm to the server default otherwise", async () => {
  expect(await runCli(["mcp", "--workspace", "/tmp", "--no-prewarm"], io)).toBe(0);
  expect(await runCli(["mcp", "--workspace", "/tmp"], io)).toBe(0);
  expect(calls[0]).toEqual([path.resolve("/tmp"), { prewarm: false }]);
  expect(calls[1]).toEqual([path.resolve("/tmp"), {}]);
});

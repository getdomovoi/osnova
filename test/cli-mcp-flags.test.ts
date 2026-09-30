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

it("passes a language server named on the command line, and rejects an incomplete or relative one", async () => {
  calls.length = 0;
  const exe = path.resolve("/usr/bin/node");
  const errors: string[] = [];
  const quiet = { stdout: () => {}, stderr: (text: string) => { errors.push(text); } };
  expect(await runCli(["mcp", "--workspace", "/tmp", "--lsp-server", exe, "--lsp-arg", "/opt/ls.js", "--lsp-arg=--stdio", "--lsp-languages", "python,typescript", "--lsp-timeout-ms", "20000"], quiet)).toBe(0);
  expect(calls[0]).toEqual([path.resolve("/tmp"), { lsp: { executable: exe, args: ["/opt/ls.js", "--stdio"], languages: ["python", "typescript"], requestTimeoutMs: 20_000 } }]);
  expect(await runCli(["mcp", "--workspace", "/tmp", "--lsp-server", "node", "--lsp-languages", "python"], quiet)).toBe(2);
  expect(await runCli(["mcp", "--workspace", "/tmp", "--lsp-server", exe], quiet)).toBe(2);
  expect(await runCli(["mcp", "--workspace", "/tmp", "--lsp-server", exe, "--lsp-languages", "cobol"], quiet)).toBe(2);
  expect(await runCli(["mcp", "--workspace", "/tmp", "--lsp-languages", "python"], quiet)).toBe(2);
  expect(await runCli(["mcp", "--workspace", "/tmp", "--lsp-server", exe, "--lsp-languages", "python", "--lsp-timeout-ms", "0"], quiet)).toBe(2);
  expect(calls).toHaveLength(1);
  expect(errors.join("")).toContain("--lsp-server must be an absolute path");
});

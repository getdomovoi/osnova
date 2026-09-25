import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const transport = vi.hoisted(() => ({ run: undefined as ((args: string[], raw: string, stdout: (text: string) => void) => Promise<number>) | undefined }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: (_exe: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stdin: EventEmitter & { end(raw: string): void }; kill(): void };
    child.stdout = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end(raw: string) {
      void transport.run!(args, raw, (text) => child.stdout.emit("data", text)).then(
        (code) => child.emit("close", code), (error: unknown) => child.emit("error", error),
      );
    } });
    child.kill = () => undefined;
    return child;
  },
}));

import { runCli } from "../src/cli/cli.js";
import { createOsnovaMcpServer } from "../src/mcp/server.js";
import { gateClients } from "../src/cli/strict-gate.js";
import type { GateClient } from "../src/cli/strict-gate.js";
import { OsnovaPlugin } from "../integrations/opencode/osnova.js";
import osnovaPi from "../integrations/pi/osnova.js";

let temporary: string, workspace: string, cacheDir: string, mcp: Client;
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-conformance-"));
  workspace = path.join(temporary, "workspace");
  cacheDir = path.join(temporary, "cache");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "a.ts"), "export function alpha() { return 1; }\n");
  await fs.writeFile(path.join(workspace, "b.ts"), "export function beta() { return 2; }\n");
  const { server } = createOsnovaMcpServer(workspace, { cacheDir });
  mcp = new Client({ name: "hook-conformance", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  await mcp.callTool({ name: "osnova_outline", arguments: { file: "a.ts" } });
  transport.run = (args, raw, stdout) => runCli([...args, "--cache-dir", cacheDir], { stdin: async () => raw, stdout, stderr: () => undefined });
});
afterEach(async () => {
  await mcp.close();
  await fs.rm(temporary, { recursive: true, force: true });
});

interface Driver {
  prompt(): Promise<unknown>;
  begin(id: string): Promise<unknown>;
  read(file: string): Promise<boolean>;
  run(command: string): Promise<boolean>;
  mark(result: unknown, id: string): Promise<unknown>;
}

async function driver(client: GateClient, query = "osnova_ground", args: Record<string, unknown> = { question: "alpha" }): Promise<Driver> {
  if (client === "opencode" || client === "kilo") {
    const hooks = await OsnovaPlugin({ directory: workspace });
    return {
      prompt: () => hooks["chat.message"]({ sessionID: "one" }, { message: {}, parts: [] }),
      begin: (callID) => hooks["tool.execute.before"]({ tool: `osnova_${query}`, sessionID: "one", callID }, { args }),
      read: async (file) => {
        try { await hooks["tool.execute.before"]({ tool: "read", sessionID: "one" }, { args: { filePath: file } }); return true; }
        catch (error) { expect(String(error)).toContain("osnova gate:"); return false; }
      },
      run: async (command) => {
        try { await hooks["tool.execute.before"]({ tool: "bash", sessionID: "one" }, { args: { command } }); return true; }
        catch (error) { expect(String(error)).toContain("osnova gate:"); return false; }
      },
      mark: (result, callID) => hooks["tool.execute.after"]({ tool: `osnova_${query}`, sessionID: "one", callID, args }, client === "kilo" ? { output: JSON.stringify(result) } : result as { content: unknown; isError?: boolean }),
    };
  }
  if (client === "pi") {
    type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>;
    const handlers = new Map<string, Handler>();
    osnovaPi({ on: (event: string, handler: unknown) => { handlers.set(event, handler as Handler); } });
    const ctx = { cwd: workspace, sessionManager: { getSessionId: () => "one" } };
    return {
      prompt: () => handlers.get("before_agent_start")!({ prompt: "", systemPrompt: "" }, ctx),
      begin: (toolCallId) => handlers.get("tool_call")!({ toolName: query, toolCallId, input: args }, ctx),
      read: async (file) => await handlers.get("tool_call")!({ toolName: "read", input: { path: file } }, ctx) === undefined,
      run: async (command) => await handlers.get("tool_call")!({ toolName: "bash", input: { command } }, ctx) === undefined,
      mark: (result, toolCallId) => handlers.get("tool_result")!({ toolName: query, toolCallId, input: args, ...result as object }, ctx),
    };
  }
  const base = client === "cursor" ? { conversation_id: "one", workspace_roots: [workspace], generation_id: "turn" } : { session_id: "one", cwd: workspace, ...(client === "codex" ? { turn_id: "turn" } : {}) };
  const invoke = async (event: string, payload: Record<string, unknown>) => {
    const out: string[] = [];
    expect(await runCli(["hook", event, "--client", client, "--cache-dir", cacheDir], { stdin: async () => JSON.stringify({ ...base, ...payload }), stdout: (text) => out.push(text), stderr: () => undefined })).toBe(0);
    return out.join("");
  };
  return {
    prompt: () => invoke(client === "cursor" ? "reset" : "prompt", { prompt: "" }),
    begin: (id) => invoke("gate", { tool_name: `mcp__osnova__${query}`, tool_use_id: id, tool_input: args }),
    read: async (file) => {
      const out = await invoke("gate", { tool_name: "Read", tool_input: { file_path: file } });
      if (out === "") return true;
      const decision = JSON.parse(out);
      expect(client === "cursor" ? decision.permission : decision.hookSpecificOutput.permissionDecision).toBe("deny");
      return false;
    },
    run: async (command) => {
      const out = await invoke("gate", { tool_name: "Bash", tool_input: { command } });
      if (out === "") return true;
      const decision = JSON.parse(out);
      expect(client === "cursor" ? decision.permission : decision.hookSpecificOutput.permissionDecision).toBe("deny");
      return false;
    },
    mark: (result, id) => invoke("mark", { tool_name: `mcp__osnova__${query}`, tool_use_id: id, tool_input: client === "cursor" ? JSON.stringify(args) : args, ...(client === "cursor" ? { tool_output: JSON.stringify(result) } : { tool_response: result }) }),
  };
}

describe("shared exploration policy through client adapters", () => {
  it.each(gateClients)("%s: query, grant, scope, edit and prompt revocation", async (client) => {
    const hooks = await driver(client);
    const query = () => mcp.callTool({ name: "osnova_ground", arguments: { question: "alpha", in: "a.ts" } });
    await hooks.prompt();
    expect(await hooks.read("a.ts")).toBe(false);
    await hooks.begin("first");
    const result = await query();
    await hooks.mark({ ...result, isError: true }, "first");
    expect(await hooks.read("a.ts")).toBe(false);
    await hooks.mark(result, "first");
    expect(await hooks.read("a.ts")).toBe(true);
    expect(await hooks.read("b.ts")).toBe(false);
    expect(await hooks.read(".")).toBe(false);
    await fs.appendFile(path.join(workspace, "b.ts"), "export const unrelated = 1;\n");
    expect(await hooks.read("a.ts")).toBe(true);
    await hooks.prompt();
    await hooks.mark(result, "first");
    expect(await hooks.read("a.ts")).toBe(false);
    await hooks.begin("second");
    await hooks.mark(await query(), "second");
    expect(await hooks.read("a.ts")).toBe(true);
    await fs.writeFile(path.join(workspace, "a.ts"), "export function alpha() { return 9; }\n");
    expect(await hooks.read("a.ts")).toBe(false);
  });
});

it.each(gateClients)("%s: opaque execution waits for an actual Osnova result", async (client) => {
  const hooks = await driver(client);
  await hooks.prompt();
  expect(await hooks.run("node -e 'process.exit(0)'"), client).toBe(false);
  await hooks.begin("execution-query");
  const result = await mcp.callTool({ name: "osnova_ground", arguments: { question: "alpha", in: "a.ts" } });
  await hooks.mark({ ...result, isError: true }, "execution-query");
  expect(await hooks.run("node -e 'process.exit(0)'"), client).toBe(false);
  await hooks.mark(result, "execution-query");
  expect(await hooks.run("node -e 'process.exit(0)'"), client).toBe(true);
});

it("Pi's MCP proxy records the underlying Osnova query before unlocking execution", async () => {
  type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  osnovaPi({ on: (event: string, handler: unknown) => { handlers.set(event, handler as Handler); } });
  const ctx = { cwd: workspace, sessionManager: { getSessionId: () => "pi-proxy" } };
  const script = { toolName: "bash", input: { command: "node -e 'process.exit(0)'" } };
  const proxy = { toolName: "mcp", toolCallId: "proxy-query", input: { tool: "osnova_ground", args: { question: "alpha", in: "a.ts" } } };
  expect(await handlers.get("tool_call")!(script, ctx)).toMatchObject({ block: true });
  expect(await handlers.get("tool_call")!(proxy, ctx)).toBeUndefined();
  const result = await mcp.callTool({ name: "osnova_ground", arguments: proxy.input.args });
  await handlers.get("tool_result")!({ ...proxy, content: result.content, isError: false }, ctx);
  expect(await handlers.get("tool_call")!(script, ctx)).toBeUndefined();
  const other = { ...proxy, input: { ...proxy.input, server: "other" } };
  const otherCtx = { ...ctx, sessionManager: { getSessionId: () => "pi-other" } };
  await handlers.get("tool_call")!(other, otherCtx);
  await handlers.get("tool_result")!({ ...other, content: result.content, isError: false }, otherCtx);
  expect(await handlers.get("tool_call")!(script, otherCtx)).toMatchObject({ block: true });
});


it.each(gateClients)("%s: footing grants named candidate tests without widening scope", async (client) => {
  const file = "test/a[1].test.ts";
  await fs.mkdir(path.join(workspace, "test"));
  await fs.writeFile(path.join(workspace, file), "import { alpha } from '../a.js';\nalpha();\n");
  await fs.writeFile(path.join(workspace, `${file}x`), "export const unrelated = 1;\n");
  const args = { symbols: ["a.ts#alpha"], depth: 1 };
  const hooks = await driver(client, "osnova_footing", args);
  const query = () => mcp.callTool({ name: "osnova_footing", arguments: args });
  await hooks.prompt();
  expect(await hooks.read(file)).toBe(false);
  await hooks.begin("footing");
  const result = await query();
  expect(JSON.stringify(result)).toContain("candidate tests:\n- test/a[1].test.ts".replaceAll("\n", "\\n"));
  await hooks.mark(result, "footing");
  expect(await hooks.read(file)).toBe(true);
  expect(await hooks.read(`${file}x`)).toBe(false);
  expect(await hooks.read("b.ts")).toBe(false);
  expect(await hooks.read("test")).toBe(false);
  await fs.appendFile(path.join(workspace, file), "alpha();\n");
  expect(await hooks.read(file)).toBe(false);
  await hooks.begin("fresh");
  await hooks.mark(await query(), "fresh");
  expect(await hooks.read(file)).toBe(true);
  await hooks.prompt();
  await hooks.mark(result, "footing");
  expect(await hooks.read(file)).toBe(false);
});

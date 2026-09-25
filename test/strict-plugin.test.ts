import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  response: "", code: 0, holdMark: false, releaseMark: undefined as (() => void) | undefined,
  calls: [] as Array<{ args: string[]; payload: Record<string, unknown> }>,
}));
vi.mock("node:child_process", () => ({
  spawn: (_exe: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stdin: EventEmitter & { end(text: string): void }; kill(): void };
    child.stdout = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end(text: string) {
      transport.calls.push({ args, payload: JSON.parse(text) as Record<string, unknown> });
      const complete = () => { child.stdout.emit("data", transport.response); child.emit("close", transport.code); };
      if (args[1] === "mark" && transport.holdMark) transport.releaseMark = complete;
      else queueMicrotask(complete);
    } });
    child.kill = () => undefined;
    return child;
  },
}));

import { OsnovaPlugin } from "../integrations/opencode/osnova.js";
import osnovaPi from "../integrations/pi/osnova.js";

afterEach(() => {
  transport.response = ""; transport.code = 0; transport.holdMark = false;
  transport.releaseMark = undefined; transport.calls = [];
});

describe("blocking plugin transports", () => {
  it("keeps prompt text and attachments intact with isolated per-message context", async () => {
    const hooks = await OsnovaPlugin({});
    const parts = [{ type: "text", text: "Find alpha" }, { type: "file" }, { type: "text", text: "then beta" }];
    const original = structuredClone(parts);
    const first: { system?: string } = { system: "custom" }, second: { system?: string } = {};
    transport.response = "POINTS alpha";
    await hooks["chat.message"]({ sessionID: "one" }, { message: first, parts });
    expect(parts).toEqual(original);
    expect(first.system).toContain("custom\n\n<osnova-context>");
    expect(first.system).toContain("POINTS alpha");
    transport.response = "POINTS beta";
    await hooks["chat.message"]({ sessionID: "two" }, { message: second, parts: [{ type: "text", text: "beta" }] });
    expect(second.system).toContain("POINTS beta");
    expect(second.system).not.toContain("POINTS alpha");
    const empty = {};
    transport.response = "";
    await hooks["chat.message"]({ sessionID: "one" }, { message: empty, parts: [] });
    expect(empty).toEqual({});
    expect(transport.calls[0]?.payload.prompt).toBe("Find alpha\nthen beta");
  });
  it("does not spawn a receipt process for ordinary tool results", async () => {
    const hooks = await OsnovaPlugin({});
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "one", args: { command: "pnpm test" } }, { output: "passed" });
    type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>;
    const handlers = new Map<string, Handler>();
    osnovaPi({ on: (event: string, handler: unknown) => { handlers.set(event, handler as Handler); } });
    await handlers.get("tool_result")!({ toolName: "bash", input: {}, content: [], isError: false }, { cwd: process.cwd() });
    expect(transport.calls).toEqual([]);
  });

  it("OpenCode/Kilo stop before execution, preserve arguments, and forward results only afterwards", async () => {
    const hooks = await OsnovaPlugin({ directory: process.cwd() });
    const input = { tool: "grep", sessionID: "one" };
    const output = { args: { pattern: "alpha" } };
    transport.response = JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "Use Osnova first" } });
    await expect(hooks["tool.execute.before"](input, output)).rejects.toThrow("Use Osnova first");
    expect(output.args).toEqual({ pattern: "alpha" });
    expect(transport.calls[0]?.args).toEqual(["hook", "gate", "--client", "opencode"]);
    expect(transport.calls[0]?.payload).toMatchObject({ session_id: "one", tool_name: "grep", tool_input: { pattern: "alpha" } });
    transport.response = "";
    await expect(hooks["tool.execute.before"]({ tool: "osnova_osnova_ground", sessionID: "one" }, { args: { question: "alpha" } })).resolves.toBeUndefined();
    expect(transport.calls.at(-1)?.args[1]).toBe("gate");
    await hooks["tool.execute.after"]({ tool: "osnova_osnova_ground", sessionID: "one", args: { question: "alpha" } }, { output: "osnova generation abc\nsrc/a.ts:1" });
    expect(transport.calls.at(-1)?.args[1]).toBe("mark");
    expect(transport.calls.at(-1)?.payload.tool_response).toEqual({ output: "osnova generation abc\nsrc/a.ts:1" });
  });

  it("OpenCode/Kilo fail closed on invalid output or a failed process", async () => {
    const hooks = await OsnovaPlugin({});
    transport.response = "bad json";
    await expect(hooks["tool.execute.before"]({ tool: "read", sessionID: "one" }, { args: { filePath: "a.ts" } })).rejects.toThrow("invalid decision");
    transport.response = "{}";
    await expect(hooks["tool.execute.before"]({ tool: "read", sessionID: "one" }, { args: { filePath: "a.ts" } })).rejects.toThrow("unsupported decision");
    transport.response = "";
    transport.code = 1;
    await expect(hooks["tool.execute.before"]({ tool: "read", sessionID: "one" }, { args: { filePath: "a.ts" } })).rejects.toThrow("unavailable");
  });

  it("OpenCode/Kilo rechecks a denied read after an overlapping query is marked", async () => {
    const hooks = await OsnovaPlugin({ directory: process.cwd() });
    const query = { tool: "osnova_osnova_footing", sessionID: "one", callID: "query-one", args: { question: "alpha" } };
    await hooks["tool.execute.before"](query, { args: query.args });
    transport.holdMark = true;
    const marking = hooks["tool.execute.after"](query, { output: "osnova generation abc\nsrc/a.ts:1" });
    expect(transport.releaseMark).toBeTypeOf("function");
    transport.response = JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "osnova gate: indexed file has no current grant." } });
    const reading = hooks["tool.execute.before"](
      { tool: "read", sessionID: "one", callID: "read-one" },
      { args: { filePath: "src/a.ts" } },
    );
    await vi.waitFor(() => expect(transport.calls.filter((call) => call.args[1] === "gate" && call.payload.tool_name === "read")).toHaveLength(1));
    transport.response = "";
    transport.releaseMark!();
    await marking;
    await expect(reading).resolves.toBeUndefined();
    expect(transport.calls.filter((call) => call.args[1] === "gate" && call.payload.tool_name === "read")).toHaveLength(2);
  });

  it("OpenCode/Kilo keeps the denial when an overlapping query grants nothing", async () => {
    const hooks = await OsnovaPlugin({ directory: process.cwd() });
    const query = { tool: "osnova_osnova_footing", sessionID: "one", callID: "query-two", args: { question: "alpha" } };
    await hooks["tool.execute.before"](query, { args: query.args });
    transport.holdMark = true;
    const marking = hooks["tool.execute.after"](query, { isError: true, output: "failed" });
    transport.response = JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "osnova gate: indexed file has no current grant." } });
    const reading = hooks["tool.execute.before"](
      { tool: "read", sessionID: "one", callID: "read-two" },
      { args: { filePath: "src/a.ts" } },
    );
    await vi.waitFor(() => expect(transport.calls.filter((call) => call.args[1] === "gate" && call.payload.tool_name === "read")).toHaveLength(1));
    transport.releaseMark!();
    await marking;
    await expect(reading).rejects.toThrow("indexed file has no current grant");
    expect(transport.calls.filter((call) => call.args[1] === "gate" && call.payload.tool_name === "read")).toHaveLength(2);
  });

  it("OpenCode/Kilo reset the right session even for a message with no text", async () => {
    const hooks = await OsnovaPlugin({});
    await hooks["chat.message"]({ sessionID: "two" }, { message: {}, parts: [] });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]).toMatchObject({ args: ["hook", "prompt"], payload: { session_id: "two", prompt: "" } });
  });

  it("Pi returns a block and records result errors without granting on a pre-call", async () => {
    type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>;
    const handlers = new Map<string, Handler>();
    osnovaPi({ on: (event: string, handler: unknown) => { handlers.set(event, handler as Handler); } });
    const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => "pi-session" } };
    transport.response = JSON.stringify({ block: true, reason: "Use Osnova first" });
    expect(await handlers.get("tool_call")!({ toolName: "read", input: { path: "a.ts" } }, ctx)).toEqual({ block: true, reason: "Use Osnova first" });
    transport.response = "";
    await handlers.get("tool_result")!({ toolName: "osnova_ground", input: {}, content: [{ text: "failed" }], isError: true }, ctx);
    expect(transport.calls.at(-1)?.payload).toMatchObject({ session_id: "pi-session", tool_response: { isError: true } });
    transport.code = 1;
    expect(await handlers.get("tool_call")!({ toolName: "read", input: {} }, ctx)).toMatchObject({ block: true });
  });
});

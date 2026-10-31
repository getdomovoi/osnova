import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// The gate plugins only shell out to `osnova hook gate`; a stand-in osnova records each call and denies an rg search.
let dir: string, calls: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-plugin-gate-"));
  calls = path.join(dir, "calls.txt");
  const fake = path.join(dir, "fake-osnova.mjs");
  await fs.writeFile(fake, "let raw=''; process.stdin.on('data',(d)=>raw+=d); process.stdin.on('end',()=>{ const p=JSON.parse(raw||'{}'); import('node:fs').then((f)=>{ f.appendFileSync(process.env.OSNOVA_CALLS, JSON.stringify({ args: process.argv.slice(2), payload: p }) + '\\n'); const command = String(p.tool_input?.command ?? ''); if (command.startsWith('rg')) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'USE OSNOVA' } })); }); });\n");
  const wrapper = path.join(dir, process.platform === "win32" ? "osnova-bin.cmd" : "osnova-bin.sh");
  await fs.writeFile(wrapper, process.platform === "win32" ? `@"${process.execPath}" "${fake}" %*\r\n` : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`, { mode: 0o755 });
  process.env.OSNOVA_BIN = wrapper;
  process.env.OSNOVA_CALLS = calls;
});
afterAll(async () => { delete process.env.OSNOVA_BIN; delete process.env.OSNOVA_CALLS; await fs.rm(dir, { recursive: true, force: true }); });
const recorded = async () => (await fs.readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as { args: string[]; payload: Record<string, unknown> });

describe("the OpenCode and Kilo gate plugin", () => {
  it("throws the gate's reason on a deny, starts turns, and never asks about calls that are not searches", async () => {
    await fs.rm(calls, { force: true });
    const { OsnovaGatePlugin } = await import("../integrations/opencode/osnova-gate.js");
    const hooks = await OsnovaGatePlugin({ directory: dir, worktree: dir });
    await hooks["chat.message"]({ sessionID: "s1" });
    await expect(hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1" }, { args: { command: "rg total" } })).rejects.toThrow("USE OSNOVA");
    await hooks["tool.execute.before"]({ tool: "grep", sessionID: "s1" }, { args: { pattern: "total" } });
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1" }, { args: { command: "ls -la" } });
    await hooks["tool.execute.before"]({ tool: "read", sessionID: "s1" }, { args: { filePath: "a.ts" } });
    const seen = await recorded();
    expect(seen.map((call) => call.args)).toEqual([["hook", "gate"], ["hook", "gate"], ["hook", "gate"]]);
    expect(seen.map((call) => call.payload.hook_event_name ?? call.payload.tool_name)).toEqual(["UserPromptSubmit", "bash", "grep"]);
    expect(seen.every((call) => call.payload.session_id === "s1" && call.payload.cwd === dir)).toBe(true);
  });
});

describe("the Pi gate extension", () => {
  it("blocks with the gate's reason, runs adaptive, and starts a turn before each agent run", async () => {
    await fs.rm(calls, { force: true });
    const { default: osnovaGate } = await import("../integrations/pi/osnova-gate.js");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    osnovaGate({ on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => { handlers.set(event, handler); } } as never);
    await handlers.get("before_agent_start")!({ prompt: "fix total", systemPrompt: "" }, { cwd: dir });
    expect(await handlers.get("tool_call")!({ toolName: "bash", input: { command: "rg total" } }, { cwd: dir })).toEqual({ block: true, reason: "USE OSNOVA" });
    expect(await handlers.get("tool_call")!({ toolName: "read", input: { path: "a.ts" } }, { cwd: dir })).toBeUndefined();
    const seen = await recorded();
    expect(seen.map((call) => call.args)).toEqual([["hook", "gate", "--adaptive"], ["hook", "gate", "--adaptive"]]);
    expect(seen[0]!.payload.session_id).toBe(seen[1]!.payload.session_id);
    // Pi's own session id, when its context gives one, keeps the gate's turns apart per session.
    await fs.rm(calls, { force: true });
    await handlers.get("tool_call")!({ toolName: "bash", input: { command: "rg total" } }, { cwd: dir, sessionManager: { getSessionId: () => "pi-session-7" } });
    expect((await recorded()).map((call) => call.payload.session_id)).toEqual(["pi-session-7"]);
  });
});

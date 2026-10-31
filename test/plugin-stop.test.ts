import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// The plugins hand the stop hook's settle notice back to the agent when a turn ends. A stand-in osnova records each
// call and answers stop in the Codex shape: continue with a reason, or a warning only for the "quiet" session.
let dir: string, calls: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-plugin-stop-"));
  calls = path.join(dir, "calls.txt");
  const fake = path.join(dir, "fake-osnova.mjs");
  await fs.writeFile(fake, "let raw=''; process.stdin.on('data',(d)=>raw+=d); process.stdin.on('end',()=>{ const p=JSON.parse(raw||'{}'); import('node:fs').then((f)=>{ f.appendFileSync(process.env.OSNOVA_CALLS, JSON.stringify({ args: process.argv.slice(2), payload: p }) + '\\n'); if (process.argv[3] !== 'stop' || p.stop_hook_active === true) return; setTimeout(() => process.stdout.write(JSON.stringify(p.session_id === 'quiet' ? { systemMessage: 'WARN' } : { decision: 'block', reason: `SETTLE ${p.session_id}` })), p.session_id === 'slow' ? 1500 : 0); }); });\n");
  const wrapper = path.join(dir, process.platform === "win32" ? "osnova-bin.cmd" : "osnova-bin.sh");
  await fs.writeFile(wrapper, process.platform === "win32" ? `@"${process.execPath}" "${fake}" %*\r\n` : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`, { mode: 0o755 });
  process.env.OSNOVA_BIN = wrapper;
  process.env.OSNOVA_CALLS = calls;
});
afterAll(async () => { delete process.env.OSNOVA_BIN; delete process.env.OSNOVA_CALLS; await fs.rm(dir, { recursive: true, force: true }); });
const stopCalls = async () => (await fs.readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as { args: string[]; payload: Record<string, unknown> }).filter((call) => call.args[1] === "stop");

describe("the OpenCode and Kilo plugin at the end of a turn", () => {
  it("recognizes its own notice by the prefix the stop hook writes (test/hook.test.ts pins it)", async () => {
    for (const file of ["integrations/opencode/osnova.js", "integrations/pi/osnova.ts"]) {
      expect(await fs.readFile(path.join(import.meta.dirname, "..", file), "utf8"), file).toContain('startsWith("[osnova settle]")');
    }
  });

  it("posts the settle notice into an idle root session, and skips child sessions and warnings", async () => {
    await fs.rm(calls, { force: true });
    const sent: unknown[] = [];
    const client = { session: { promptAsync: async (options: unknown) => { sent.push(options); return { response: { status: 204 } }; } } };
    const { OsnovaPlugin } = await import("../integrations/opencode/osnova.js");
    const hooks = await OsnovaPlugin({ directory: dir, worktree: dir, client });
    expect(Object.keys(hooks).sort()).toEqual(["chat.message", "event"]);
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "child", parentID: "root" } } } });
    // A message carries its session's id as parentID; it is not a child session.
    await hooks.event({ event: { type: "message.updated", properties: { info: { id: "quiet", parentID: "root" } } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "child" } } });
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "root" } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "quiet" } } });
    await vi.waitFor(async () => expect((await stopCalls()).length).toBe(1));
    expect(sent).toEqual([]);
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } });
    await vi.waitFor(() => expect(sent).toEqual([{ path: { id: "root" }, body: { parts: [{ type: "text", text: "SETTLE root" }] } }]));
    // The posted notice arrives as a user message; it already names each dependent, so it gets no starting points.
    const parts = [{ type: "text", text: "[osnova settle] The uncommitted diff touches 1 indexed symbols; check `audit`" }];
    await hooks["chat.message"]({ sessionID: "root" }, { message: {}, parts });
    expect(parts[0]!.text).toBe("[osnova settle] The uncommitted diff touches 1 indexed symbols; check `audit`");
    const prompts = (await fs.readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { args: string[] }).filter((call) => call.args[1] === "prompt");
    expect(prompts).toEqual([]);
    // The turn the notice started ends as a stop hook continuation, which never continues again.
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } });
    await vi.waitFor(async () => expect((await stopCalls()).length).toBe(3));
    // A turn the user starts is checked afresh.
    await hooks["chat.message"]({ sessionID: "root" }, { message: {}, parts: [{ type: "text", text: "now rename it" }] });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } });
    await vi.waitFor(async () => expect((await stopCalls()).length).toBe(4));
    const seen = await stopCalls();
    expect(seen.map((call) => [call.payload.session_id, call.payload.stop_hook_active ?? false])).toEqual([["quiet", false], ["root", false], ["root", true], ["root", false]]);
    expect(seen.every((call) => call.args.join(" ") === "hook stop --client codex" && call.payload.cwd === dir)).toBe(true);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
  });

  it("skips a turn the user aborted and a notice the user's next prompt overtook", async () => {
    await fs.rm(calls, { force: true });
    const sent: unknown[] = [];
    const client = { session: { promptAsync: async (options: unknown) => { sent.push(options); return {}; } } };
    const { OsnovaPlugin } = await import("../integrations/opencode/osnova.js");
    const hooks = await OsnovaPlugin({ directory: dir, worktree: dir, client });
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "root", error: { name: "MessageAbortedError" } } } });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } });
    expect(await stopCalls()).toEqual([]);
    // The idle after the aborted one is checked again.
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    // The user prompts while the stop hook runs; the notice would land inside the user's turn.
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "slow" } } });
    await hooks["chat.message"]({ sessionID: "slow" }, { message: {}, parts: [{ type: "text", text: "next task" }] });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(sent).toHaveLength(1);
  }, 10_000);
});

describe("the Pi extension at the end of a run", () => {
  const setup = async () => {
    const sent: unknown[][] = [];
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const { default: osnova } = await import("../integrations/pi/osnova.js");
    osnova({ on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => { handlers.set(event, handler); }, sendUserMessage: (...args: unknown[]) => { sent.push(args); } } as never);
    return { sent, handlers };
  };
  const ctx = (id: string | undefined, idle = true) => ({ cwd: dir, isIdle: () => idle, sessionManager: id === undefined ? undefined : { getSessionId: () => id } });

  it("sends the settle notice as a user message once the run settles, and skips aborted runs and warnings", async () => {
    await fs.rm(calls, { force: true });
    const { sent, handlers } = await setup();
    const settled = handlers.get("agent_settled")!;
    await settled({ aborted: true }, ctx("pi-1"));
    await settled({ aborted: false }, ctx("quiet"));
    expect(sent).toEqual([]);
    await settled({ aborted: false }, ctx("pi-1"));
    expect(sent).toEqual([["SETTLE pi-1"]]);
    // The notice starts the next run as its prompt; it gets the contract but no starting points.
    await handlers.get("before_agent_start")!({ prompt: "[osnova settle] check `audit`", systemPrompt: "base" }, ctx("pi-1"));
    const prompts = (await fs.readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { args: string[] }).filter((call) => call.args[1] === "prompt");
    expect(prompts).toEqual([]);
    // That run settles as a stop hook continuation; the user's next run is checked afresh.
    await settled({ aborted: false }, ctx("pi-1"));
    await handlers.get("before_agent_start")!({ prompt: "now rename it", systemPrompt: "base" }, ctx("pi-1"));
    await settled({ aborted: false }, ctx("pi-1"));
    expect((await stopCalls()).map((call) => [call.payload.session_id, call.payload.stop_hook_active ?? false])).toEqual([["quiet", false], ["pi-1", false], ["pi-1", true], ["pi-1", false]]);
    expect(sent).toHaveLength(2);
  });

  it("keys a run without a Pi session id on the process, and queues the notice behind a run already streaming", async () => {
    await fs.rm(calls, { force: true });
    const { sent, handlers } = await setup();
    await handlers.get("agent_settled")!({ aborted: false }, ctx(undefined, false));
    const [call] = await stopCalls();
    expect(String(call!.payload.session_id)).toMatch(/^pi-\d+-\d+$/);
    expect(sent).toEqual([[`SETTLE ${String(call!.payload.session_id)}`, { deliverAs: "followUp" }]]);
  });
});

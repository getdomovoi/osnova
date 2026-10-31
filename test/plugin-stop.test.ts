import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// The plugins hand the stop hook's settle notice back to the agent when a turn ends. A stand-in osnova records each
// call and plays the deferred stop hook: a notice with a digest until the session acknowledges it, a warning after
// that and always for the "quiet" session; the "slow" session answers after 1.5 seconds.
let dir: string, calls: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "osnova-plugin-stop-"));
  calls = path.join(dir, "calls.txt");
  const fake = path.join(dir, "fake-osnova.mjs");
  await fs.writeFile(fake, `
let raw = ""; process.stdin.on("data", (d) => raw += d); process.stdin.on("end", async () => {
  const fs = await import("node:fs");
  const p = JSON.parse(raw || "{}"); const args = process.argv.slice(2);
  fs.appendFileSync(process.env.OSNOVA_CALLS, JSON.stringify({ args, payload: p }) + "\\n");
  if (args[1] !== "stop") return;
  const acks = process.env.OSNOVA_CALLS + ".acks";
  if (args.includes("--ack")) { fs.appendFileSync(acks, p.session_id + "\\n"); return; }
  const settled = (fs.existsSync(acks) ? fs.readFileSync(acks, "utf8") : "").split("\\n").includes(p.session_id);
  const answer = p.session_id === "quiet" || settled ? { systemMessage: "WARN" } : { decision: "block", reason: "SETTLE " + p.session_id, digest: "0123456789abcdef" };
  setTimeout(() => process.stdout.write(JSON.stringify(answer)), p.session_id === "slow" ? 1500 : 0);
});
`);
  const wrapper = path.join(dir, process.platform === "win32" ? "osnova-bin.cmd" : "osnova-bin.sh");
  await fs.writeFile(wrapper, process.platform === "win32" ? `@"${process.execPath}" "${fake}" %*\r\n` : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`, { mode: 0o755 });
  process.env.OSNOVA_BIN = wrapper;
  process.env.OSNOVA_CALLS = calls;
});
afterAll(async () => { delete process.env.OSNOVA_BIN; delete process.env.OSNOVA_CALLS; await fs.rm(dir, { recursive: true, force: true }); });
const reset = async () => { await fs.rm(calls, { force: true }); await fs.rm(`${calls}.acks`, { force: true }); };
const recorded = async () => (await fs.readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as { args: string[]; payload: Record<string, unknown> });
const checks = async (session?: string) => (await recorded()).filter((call) => call.args.join(" ") === "hook stop --client codex --defer" && (session === undefined || call.payload.session_id === session));
const acks = async (session?: string) => (await recorded()).filter((call) => call.args.includes("--ack") && (session === undefined || call.payload.session_id === session));
const prompts = async () => (await recorded()).filter((call) => call.args[1] === "prompt");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the OpenCode and Kilo plugin at the end of a turn", () => {
  const open = async (promptAsync: (options: unknown) => Promise<unknown>) => {
    const { OsnovaPlugin } = await import("../integrations/opencode/osnova.js");
    return OsnovaPlugin({ directory: dir, worktree: dir, client: { session: { promptAsync } } });
  };
  const idle = (sessionID: string) => ({ event: { type: "session.idle", properties: { sessionID } } });
  const say = (text: string) => ({ message: {}, parts: [{ type: "text", text }] });

  it("posts one notice per user prompt into an idle root session, acknowledges it, and skips child sessions and warnings", async () => {
    await reset();
    const sent: unknown[] = [];
    const hooks = await open(async (options) => { sent.push(options); return {}; });
    expect(Object.keys(hooks).sort()).toEqual(["chat.message", "event"]);
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "child", parentID: "root" } } } });
    // A message carries its session's id as parentID; it is not a child session.
    await hooks.event({ event: { type: "message.updated", properties: { info: { id: "quiet", parentID: "root" } } } });
    await hooks.event(idle("child"));
    await hooks.event(idle("quiet"));
    await vi.waitFor(async () => expect(await checks()).toHaveLength(1));
    expect(sent).toEqual([]);
    await hooks.event(idle("root"));
    await vi.waitFor(async () => expect(await acks("root")).toHaveLength(1));
    expect(sent).toEqual([{ path: { id: "root" }, body: { parts: [{ type: "text", text: "SETTLE root" }] } }]);
    expect((await acks("root"))[0]!.args).toEqual(["hook", "stop", "--client", "codex", "--ack", "0123456789abcdef"]);
    // The posted notice arrives as a message; it already names each dependent, so it gets no starting points, and the
    // turn it starts gets no second notice even if that turn changes the diff.
    // Another plugin may already have appended to it.
    const own = say("SETTLE root\n\n[another plugin] note");
    await hooks["chat.message"]({ sessionID: "root" }, own);
    expect(own.parts[0]!.text).toBe("SETTLE root\n\n[another plugin] note");
    expect(await prompts()).toEqual([]);
    await fs.rm(`${calls}.acks`, { force: true });
    await hooks.event(idle("root"));
    await pause(200);
    expect(await checks("root")).toHaveLength(1);
    // The user's next prompt, even one that pastes the notice back, is checked afresh.
    await hooks["chat.message"]({ sessionID: "root" }, say("SETTLE root\nwhy is this flagged?"));
    await hooks.event(idle("root"));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect((await checks()).every((call) => call.payload.cwd === dir)).toBe(true);
  });

  it("stays quiet after an abort until the user prompts again, and offers a notice again when posting it fails", async () => {
    await reset();
    let fail = true;
    const sent: unknown[] = [];
    const hooks = await open(async (options) => { if (fail) throw new Error("server busy"); sent.push(options); return {}; });
    // Kilo reports the abort, then goes idle twice.
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "aborted", error: { name: "MessageAbortedError" } } } });
    await hooks.event(idle("aborted"));
    await hooks.event(idle("aborted"));
    await pause(200);
    expect(await checks("aborted")).toEqual([]);
    await hooks["chat.message"]({ sessionID: "aborted" }, say("try again"));
    await hooks.event(idle("aborted"));
    await vi.waitFor(async () => expect(await checks("aborted")).toHaveLength(1));
    await pause(100);
    expect(await acks("aborted")).toEqual([]);
    fail = false;
    await hooks.event(idle("aborted"));
    await vi.waitFor(async () => expect(await acks("aborted")).toHaveLength(1));
    expect(sent).toHaveLength(1);
  });

  it("checks the turn of a prompt the user sent while the notice was posting", async () => {
    await reset();
    let release = (): void => undefined;
    const sent: unknown[] = [];
    const hooks = await open((options) => new Promise((resolve) => { sent.push(options); release = () => resolve({}); }));
    await hooks.event(idle("racing"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await hooks["chat.message"]({ sessionID: "racing" }, say("and then this"));
    release();
    await vi.waitFor(async () => expect(await acks("racing")).toHaveLength(1));
    await fs.rm(`${calls}.acks`, { force: true });
    await hooks.event(idle("racing"));
    await vi.waitFor(async () => expect(await checks("racing")).toHaveLength(2));
  });

  it("runs one check at a time per session and forgets a deleted session", async () => {
    await reset();
    const sent: unknown[] = [];
    const hooks = await open(async (options) => { sent.push(options); return {}; });
    await hooks.event(idle("slow"));
    await hooks.event(idle("slow"));
    await vi.waitFor(async () => expect(await acks("slow")).toHaveLength(1), { timeout: 5_000 });
    await pause(200);
    expect(await checks("slow")).toHaveLength(1);
    expect(sent).toHaveLength(1);
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "gone", parentID: "root" } } } });
    await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "gone" } } } });
    await hooks.event(idle("gone"));
    await vi.waitFor(async () => expect(await checks("gone")).toHaveLength(1));
  }, 10_000);
});

describe("the Pi extension at the end of a run", () => {
  const setup = async (send: (...args: unknown[]) => void) => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const { default: osnova } = await import("../integrations/pi/osnova.js");
    osnova({ on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => { handlers.set(event, handler); }, sendUserMessage: send } as never);
    return { start: handlers.get("before_agent_start")!, settled: handlers.get("agent_settled")! };
  };
  const ctx = (id: string | undefined, idle = true) => ({ cwd: dir, isIdle: () => idle, sessionManager: id === undefined ? undefined : { getSessionId: () => id } });

  it("sends one notice per user prompt once a run settles, acknowledges it, and skips aborted runs and warnings", async () => {
    await reset();
    const sent: unknown[][] = [];
    const { start, settled } = await setup((...args) => { sent.push(args); });
    await settled({ aborted: true }, ctx("pi-1"));
    await settled({ aborted: false }, ctx("quiet"));
    expect(sent).toEqual([]);
    await settled({ aborted: false }, ctx("pi-1"));
    expect(sent).toEqual([["SETTLE pi-1"]]);
    expect(await acks("pi-1")).toHaveLength(1);
    // The notice starts the next run as its prompt; it gets the contract but no starting points, and that run gets
    // no second notice.
    await start({ prompt: "SETTLE pi-1\n\n[another extension] note", systemPrompt: "base" }, ctx("pi-1"));
    expect(await prompts()).toEqual([]);
    await fs.rm(`${calls}.acks`, { force: true });
    await settled({ aborted: false }, ctx("pi-1"));
    expect(sent).toHaveLength(1);
    await start({ prompt: "now rename it", systemPrompt: "base" }, ctx("pi-1"));
    await settled({ aborted: false }, ctx("pi-1"));
    expect(sent).toHaveLength(2);
    expect((await checks()).map((call) => call.payload.session_id)).toEqual(["quiet", "pi-1", "pi-1"]);
  });

  it("keys a run without a Pi session id on the process and queues the notice behind a run already streaming", async () => {
    await reset();
    const sent: unknown[][] = [];
    const { settled } = await setup((...args) => { sent.push(args); });
    await settled({ aborted: false }, ctx(undefined, false));
    const [call] = await checks();
    expect(String(call!.payload.session_id)).toMatch(/^pi-\d+-\d+$/);
    expect(sent).toEqual([[`SETTLE ${String(call!.payload.session_id)}`, { deliverAs: "followUp" }]]);
  });

  it("falls back to a follow-up when Pi refuses a plain message, and offers the notice again when Pi refuses both", async () => {
    await reset();
    let refuseAll = false;
    const sent: unknown[][] = [];
    const { settled } = await setup((...args) => { if (refuseAll || args.length === 1) throw new Error("streaming"); sent.push(args); });
    await settled({ aborted: false }, ctx("pi-3"));
    expect(sent).toEqual([["SETTLE pi-3", { deliverAs: "followUp" }]]);
    expect(await acks("pi-3")).toHaveLength(1);
    refuseAll = true;
    await settled({ aborted: false }, ctx("pi-4"));
    expect(await acks("pi-4")).toEqual([]);
    refuseAll = false;
    await settled({ aborted: false }, ctx("pi-4"));
    expect(await acks("pi-4")).toHaveLength(1);
  });
});

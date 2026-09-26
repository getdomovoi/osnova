import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The plugin and the Pi extension decide how to start osnova when they load, from process.platform and
// OSNOVA_BIN, so each case sets both and imports a fresh copy with spawn replaced.
const calls: { command: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
let closeChildren = true;
vi.mock("node:child_process", () => ({
  spawn: (command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new EventEmitter(),
      stdin: { end: () => { if (closeChildren && command !== "taskkill") setImmediate(() => { child.stdout.emit("data", "CONTRACT"); child.emit("close", 0); }); } },
      kill: () => { calls.push({ command: "kill()", args: [], options: {} }); return true; },
    });
    return child;
  },
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

async function loadPlugin(os: string, bin: string): Promise<(system: string[]) => Promise<string[]>> {
  Object.defineProperty(process, "platform", { ...platform, value: os });
  process.env.OSNOVA_BIN = bin;
  vi.resetModules();
  const { OsnovaPlugin } = await import("../integrations/opencode/osnova.js");
  const hooks = await OsnovaPlugin({ directory: "/w", worktree: "/w" });
  return async (system) => { await hooks["experimental.chat.system.transform"]({}, { system }); return system; };
}

async function sessionHookOn(os: string, bin: string): Promise<string[]> {
  return (await loadPlugin(os, bin))([]);
}

beforeEach(() => { calls.length = 0; closeChildren = true; });
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  delete process.env.OSNOVA_BIN;
  vi.useRealTimers();
});

describe("starting osnova from the plugin on Windows", () => {
  it("runs the .cmd shim through the shell with the path quoted", async () => {
    expect(await sessionHookOn("win32", "C:\\Program Files\\osnova\\osnova.cmd")).toEqual(["CONTRACT"]);
    expect(calls[0]).toMatchObject({ command: "\"C:\\Program Files\\osnova\\osnova.cmd\"", args: ["hook", "session", "--full-contract"], options: { shell: true } });
  });

  it("never hands cmd.exe a path it would read as syntax", async () => {
    for (const bin of ["C:\\Tools\\bad\" & echo INJECTED & \"foo.cmd", "C:\\Users\\%USERNAME%\\osnova.cmd", "C:\\a|b\\osnova.cmd", "C:\\a^b\\osnova.cmd"]) {
      expect(await sessionHookOn("win32", bin)).toEqual([]);
    }
    expect(calls).toEqual([]);
  });

  it("keeps a direct start everywhere else", async () => {
    expect(await sessionHookOn("linux", "/opt/osnova 1/bin/osnova")).toEqual(["CONTRACT"]);
    expect(calls[0]).toMatchObject({ command: "/opt/osnova 1/bin/osnova", options: { shell: false } });
  });

  it("ends the whole process tree when a hook times out on Windows", async () => {
    const session = await loadPlugin("win32", "osnova");
    vi.useFakeTimers();
    closeChildren = false;
    const pending = session([]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toEqual([]);
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([["\"osnova\"", "hook", "session", "--full-contract"], ["taskkill", "/pid", "4242", "/t", "/f"]]);
  });
});

describe("starting osnova from the Pi extension on Windows", () => {
  it("applies the same quoting, refusal and tree kill", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    process.env.OSNOVA_BIN = "C:\\Users\\%USERNAME%\\osnova.cmd";
    vi.resetModules();
    const { default: osnova } = await import("../integrations/pi/osnova.js");
    let handler: ((event: { systemPrompt: string; prompt?: string }, ctx: { cwd?: string }) => Promise<unknown>) | undefined;
    osnova({ on: (_event: string, fn: typeof handler) => { handler = fn; } });
    await handler!({ systemPrompt: "base", prompt: "why" }, { cwd: "/w" });
    expect(calls).toEqual([]);
  });
});

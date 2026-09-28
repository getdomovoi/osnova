import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The plugin and the Pi extension decide how to start osnova when they load, from process.platform and
// OSNOVA_BIN, so each case sets both and imports a fresh copy with spawn replaced.
const calls: { command: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
let closeChildren = true;
let taskkillFails = false;
vi.mock("node:child_process", () => ({
  spawn: (command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new EventEmitter(),
      stdin: { end: () => { if (closeChildren && command !== "taskkill") setImmediate(() => { child.stdout.emit("data", "CONTRACT"); child.emit("close", 0); }); } },
      kill: () => { calls.push({ command: "kill()", args: [], options: {} }); return true; },
    });
    if (command === "taskkill" && taskkillFails) setImmediate(() => child.emit("error", new Error("spawn taskkill ENOENT")));
    return child;
  },
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

async function loadPlugin(os: string, bin: string): Promise<(prompt: string) => Promise<string>> {
  Object.defineProperty(process, "platform", { ...platform, value: os });
  process.env.OSNOVA_BIN = bin;
  vi.resetModules();
  const { OsnovaPlugin } = await import("../integrations/opencode/osnova.js");
  const hooks = await OsnovaPlugin({ directory: "/w", worktree: "/w" });
  return async (prompt) => { const parts = [{ type: "text", text: prompt }]; await hooks["chat.message"]({}, { message: {}, parts }); return parts[0]!.text; };
}

async function promptHookOn(os: string, bin: string): Promise<string> {
  return (await loadPlugin(os, bin))("why");
}

beforeEach(() => { calls.length = 0; closeChildren = true; taskkillFails = false; });
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  delete process.env.OSNOVA_BIN;
  vi.useRealTimers();
});

describe("starting osnova from the plugin on Windows", () => {
  it("runs the .cmd shim through the shell with the path quoted", async () => {
    expect(await promptHookOn("win32", "C:\\Program Files\\osnova\\osnova.cmd")).toBe("why\n\nCONTRACT");
    const quoted = "\"C:\\Program Files\\osnova\\osnova.cmd\"";
    expect(calls.map((call) => ({ command: call.command, args: call.args, shell: call.options.shell }))).toEqual([
      { command: quoted, args: ["hook", "session"], shell: true }, { command: quoted, args: ["hook", "prompt"], shell: true }]);
  });

  it("never hands cmd.exe a path that could leave its quotes or expand", async () => {
    for (const bin of ["C:\\Tools\\bad\" & echo INJECTED & \"foo.cmd", "C:\\Users\\%USERNAME%\\osnova.cmd", "C:\\Tools\\wow!\\osnova.cmd", "C:\\a\nb\\osnova.cmd"]) {
      expect(await promptHookOn("win32", bin)).toBe("why");
    }
    expect(calls).toEqual([]);
  });

  it("runs a path whose &, |, ^, < or > cmd.exe reads literally inside quotes", async () => {
    for (const bin of ["C:\\Tools & More\\osnova.cmd", "C:\\a|b\\osnova.cmd", "C:\\a^b\\osnova.cmd", "C:\\a<b>\\osnova.cmd"]) {
      expect(await promptHookOn("win32", bin)).toBe("why\n\nCONTRACT");
    }
    expect(calls.filter((call) => call.args[1] === "prompt").map((call) => call.command)).toEqual(["\"C:\\Tools & More\\osnova.cmd\"", "\"C:\\a|b\\osnova.cmd\"", "\"C:\\a^b\\osnova.cmd\"", "\"C:\\a<b>\\osnova.cmd\""]);
  });

  it("keeps a direct start everywhere else", async () => {
    expect(await promptHookOn("linux", "/opt/osnova 1/bin/osnova")).toBe("why\n\nCONTRACT");
    expect(calls[0]).toMatchObject({ command: "/opt/osnova 1/bin/osnova", options: { shell: false } });
  });

  it("ends the whole process tree when a hook times out on Windows", async () => {
    const session = await loadPlugin("win32", "osnova");
    vi.useFakeTimers();
    closeChildren = false;
    const pending = session("why");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe("why");
    const taskkill = ["taskkill", "/pid", "4242", "/t", "/f"];
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([["\"osnova\"", "hook", "session"], taskkill, ["\"osnova\"", "hook", "prompt"], taskkill]);
  });

  it("kills the shell itself when taskkill cannot run", async () => {
    const session = await loadPlugin("win32", "osnova");
    vi.useFakeTimers();
    closeChildren = false;
    taskkillFails = true;
    const pending = session("why");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe("why");
    await vi.runAllTimersAsync();
    // Each hook's fallback kill runs after its taskkill fails, which can land after the next hook has started.
    expect(calls.map((call) => call.command).sort()).toEqual(["\"osnova\"", "\"osnova\"", "kill()", "kill()", "taskkill", "taskkill"]);
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

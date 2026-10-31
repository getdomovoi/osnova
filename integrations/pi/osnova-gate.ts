// Osnova gate extension for Pi, opt-in: it blocks a search that reaches indexed code until an osnova tool or the
// osnova CLI has run in the turn. All logic lives in `osnova hook gate`; this file only shells out to it and lets
// the tool run whenever osnova does not answer. Pi tools reach osnova through pi-mcp-adapter, whose calls the gate
// may not recognize, so it runs adaptive: once per turn until it has seen an osnova call, strict after that.
// Install it beside osnova.ts with `osnova setup --apply --client pi --plugin --gate`. OSNOVA_GATE=off switches it
// off; OSNOVA_BIN runs another osnova executable.
import { spawn } from "node:child_process";

const executable = process.env.OSNOVA_BIN ?? "osnova";
// On Windows the osnova command is an npm .cmd shim, which Node starts only through a shell.
const windows = process.platform === "win32";
// Inside double quotes cmd.exe reads &, |, <, >, and ^ literally, but a quote ends the quoting and % or ! expands
// a variable, so a path holding one of those, or a line break, is not run.
const unsafeOnWindows = /["%!\r\n]/;
// Tool calls the gate may decide on: search tools, MCP calls, and shell commands that search or run osnova.
const searchTool = /^(?:grep|find|mcp)$|osnova_/;
const searchCommand = /(?:^|[\s;&|(])(?:grep|egrep|fgrep|rg|ag|ack|fd|find|git\s+grep|osnova)(?:\s|$)/;
// Pi's session id when its context gives one; otherwise one process is one session.
const processSession = `pi-${process.pid}-${Date.now()}`;

function gate(payload: Record<string, unknown>, cwd: string, session: string): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    if (process.env.OSNOVA_GATE === "off" || (windows && unsafeOnWindows.test(executable))) { resolve(""); return; }
    try {
      const child = spawn(windows ? `"${executable}"` : executable, ["hook", "gate", "--adaptive"], { cwd, stdio: ["pipe", "pipe", "ignore"], shell: windows, windowsHide: true });
      // Through a shell, kill() ends only cmd.exe; taskkill /t also ends the osnova process it started.
      const stop = () => {
        if (!windows || child.pid === undefined) { child.kill(); return; }
        // When taskkill cannot start or fails, ending the shell is still better than nothing.
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => child.kill());
        killer.on("exit", (code) => { if (code !== 0) child.kill(); });
      };
      const timer = setTimeout(() => { stop(); resolve(""); }, 10_000);
      child.stdout.on("data", (chunk: Buffer | string) => { out += chunk; });
      child.on("error", () => { clearTimeout(timer); resolve(""); });
      child.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
      child.stdin.end(JSON.stringify({ ...payload, session_id: session, cwd }));
    } catch { resolve(""); }
  });
}

// The deny reason in the gate's answer, or undefined when the tool may run.
function denyReason(answer: string): string | undefined {
  try {
    const output = (JSON.parse(answer) as { hookSpecificOutput?: { permissionDecision?: unknown; permissionDecisionReason?: unknown } }).hookSpecificOutput;
    return output?.permissionDecision === "deny" && typeof output.permissionDecisionReason === "string" ? output.permissionDecisionReason : undefined;
  } catch { return undefined; }
}

interface ToolCall { readonly toolName?: string; readonly input?: Record<string, unknown> }
interface Context { readonly cwd?: string; readonly sessionManager?: { getSessionId?(): string | undefined } }
const sessionOf = (ctx: Context | undefined): string => ctx?.sessionManager?.getSessionId?.() || processSession;
interface PiApi {
  on(event: "before_agent_start", handler: (event: unknown, ctx: Context) => Promise<undefined>): void;
  on(event: "tool_call", handler: (event: ToolCall, ctx: Context) => Promise<{ block: true; reason: string } | undefined>): void;
}

export default function osnovaGate(pi: PiApi): void {
  pi.on("before_agent_start", async (_event, ctx) => {
    const cwd = ctx?.cwd ?? process.cwd();
    await gate({ hook_event_name: "UserPromptSubmit" }, cwd, sessionOf(ctx));
    return undefined;
  });
  pi.on("tool_call", async (event, ctx) => {
    const tool = String(event?.toolName ?? "");
    const input = event?.input ?? {};
    if (!searchTool.test(tool) && !(tool === "bash" && searchCommand.test(String(input.command ?? "")))) return undefined;
    const cwd = ctx?.cwd ?? process.cwd();
    const reason = denyReason(await gate({ tool_name: tool, tool_input: input }, cwd, sessionOf(ctx)));
    return reason === undefined ? undefined : { block: true, reason };
  });
}

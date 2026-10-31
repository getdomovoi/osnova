// Osnova extension for Pi: the tool contract and starting points for the prompt go into the system
// prompt before each agent run, and once a run settles, what the uncommitted change reached comes back as a user
// message so the agent checks it. All logic lives in `osnova hook`; this file only shells out to it.
// Install by copying it into ~/.pi/agent/extensions/, or run `osnova setup --apply --client pi --plugin`.
// Set OSNOVA_BIN to run another osnova executable. Pi tools reach the graph through pi-mcp-adapter.
import { spawn } from "node:child_process";

const executable = process.env.OSNOVA_BIN ?? "osnova";
// On Windows the osnova command is an npm .cmd shim, which Node starts only through a shell.
const windows = process.platform === "win32";
// Inside double quotes cmd.exe reads &, |, <, >, and ^ literally, but a quote ends the quoting and % or ! expands
// a variable, so a path holding one of those, or a line break, is not run.
const unsafeOnWindows = /["%!\r\n]/;

function hook(event: string, payload: unknown, cwd: string, ...flags: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    if (windows && unsafeOnWindows.test(executable)) { resolve(""); return; }
    try {
      const child = spawn(windows ? `"${executable}"` : executable, ["hook", event, ...flags], { cwd, stdio: ["pipe", "pipe", "ignore"], shell: windows, windowsHide: true });
      // Through a shell, kill() ends only cmd.exe; taskkill /t also ends the osnova process it started.
      const stop = () => {
        if (!windows || child.pid === undefined) { child.kill(); return; }
        // When taskkill cannot start or fails, ending the shell is still better than nothing.
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => child.kill());
        killer.on("exit", (code) => { if (code !== 0) child.kill(); });
      };
      const timer = setTimeout(() => { stop(); resolve(""); }, 15_000);
      child.stdout.on("data", (chunk: Buffer | string) => { out += chunk; });
      child.on("error", () => { clearTimeout(timer); resolve(""); });
      child.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
      child.stdin.end(JSON.stringify(payload));
    } catch { resolve(""); }
  });
}

// The stop hook in the Codex shape: `decision: "block"` with a reason when the agent should check its change, a
// `systemMessage` warning otherwise. Only the first starts a new turn.
function continueReason(answer: string): string | undefined {
  try {
    const parsed = JSON.parse(answer) as { decision?: unknown; reason?: unknown };
    return parsed.decision === "block" && typeof parsed.reason === "string" && parsed.reason.length > 0 ? parsed.reason : undefined;
  } catch { return undefined; }
}

interface BeforeAgentStart { readonly prompt?: string; readonly systemPrompt: string }
interface AgentSettled { readonly aborted?: boolean }
interface Context { readonly cwd?: string; readonly sessionManager?: { getSessionId?(): string | undefined } }
interface PiApi {
  on(event: "before_agent_start", handler: (event: BeforeAgentStart, ctx: Context) => Promise<{ systemPrompt?: string } | undefined>): void;
  on(event: "agent_settled", handler: (event: AgentSettled, ctx: Context) => Promise<undefined>): void;
  sendUserMessage(content: string): void;
}

export default function osnova(pi: PiApi): void {
  let contract: string | undefined;
  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx?.cwd ?? process.cwd();
    contract ??= await hook("session", { cwd }, cwd, "--full-contract");
    // The settle notice this extension sends already names each dependent with its line; it needs no starting points.
    const points = typeof event.prompt === "string" && !event.prompt.startsWith("[osnova settle]") ? await hook("prompt", { prompt: event.prompt, cwd }, cwd) : "";
    const extra = [contract, points].filter((part) => part.length > 0).join("\n\n");
    return extra.length === 0 ? undefined : { systemPrompt: `${event.systemPrompt}\n\n${extra}` };
  });
  // agent_settled is the run's final idle point, after retries and compaction. A run the user aborted gets no notice.
  // The stop hook continues at most once per diff per session, so the run the notice starts ends quietly.
  pi.on("agent_settled", async (event, ctx) => {
    const session = ctx?.sessionManager?.getSessionId?.();
    if (event?.aborted === true || typeof session !== "string" || session.length === 0) return undefined;
    const cwd = ctx?.cwd ?? process.cwd();
    const reason = continueReason(await hook("stop", { session_id: session, cwd }, cwd, "--client", "codex"));
    if (reason !== undefined) pi.sendUserMessage(reason);
    return undefined;
  });
}

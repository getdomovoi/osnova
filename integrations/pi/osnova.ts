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
      // The stop hook refreshes the index and walks the diff's dependents, so it gets the 30 seconds hooks.json gives it.
      const timer = setTimeout(() => { stop(); resolve(""); }, event === "stop" ? 30_000 : 15_000);
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
interface Context { readonly cwd?: string; isIdle?(): boolean; readonly sessionManager?: { getSessionId?(): string | undefined } }
interface PiApi {
  on(event: "before_agent_start", handler: (event: BeforeAgentStart, ctx: Context) => Promise<{ systemPrompt?: string } | undefined>): void;
  on(event: "agent_settled", handler: (event: AgentSettled, ctx: Context) => Promise<undefined>): void;
  // Pi throws for a message sent while a run streams unless it says how to deliver it.
  sendUserMessage(content: string, options?: { deliverAs: "followUp" | "steer" }): void;
}

// Pi's session id when its context gives one; otherwise one process is one session. Both osnova extensions read the
// fallback from one global, so they key the same session when Pi loads both.
const fallback = globalThis as { osnovaPiSession?: string };
const processSession = (fallback.osnovaPiSession ??= `pi-${process.pid}-${Date.now()}`);
const sessionOf = (ctx: Context | undefined): string => ctx?.sessionManager?.getSessionId?.() || processSession;

export default function osnova(pi: PiApi): void {
  let contract: string | undefined;
  // Sessions whose running run the sent notice started: it settles as a stop hook continuation, which the hook never
  // continues again. Each run's prompt sets or clears the mark, so it follows the run that is going.
  const noticed = new Set<string>();
  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx?.cwd ?? process.cwd();
    if (typeof event.prompt === "string" && event.prompt.startsWith("[osnova settle]")) noticed.add(sessionOf(ctx));
    else noticed.delete(sessionOf(ctx));
    contract ??= await hook("session", { cwd }, cwd, "--full-contract");
    // The settle notice this extension sends already names each dependent with its line; it needs no starting points.
    const points = typeof event.prompt === "string" && !event.prompt.startsWith("[osnova settle]") ? await hook("prompt", { prompt: event.prompt, cwd }, cwd) : "";
    const extra = [contract, points].filter((part) => part.length > 0).join("\n\n");
    return extra.length === 0 ? undefined : { systemPrompt: `${event.systemPrompt}\n\n${extra}` };
  });
  // agent_settled is the run's final idle point, after retries and compaction. A run the user aborted gets no notice.
  pi.on("agent_settled", async (event, ctx) => {
    const session = sessionOf(ctx);
    const continuation = noticed.has(session);
    if (event?.aborted === true) return undefined;
    const cwd = ctx?.cwd ?? process.cwd();
    const reason = continueReason(await hook("stop", { session_id: session, cwd, ...(continuation ? { stop_hook_active: true } : {}) }, cwd, "--client", "codex"));
    if (reason === undefined) return undefined;
    // The hook has already recorded the diff as settled, so the notice must go out: after a run the user started while
    // the hook ran, and as a follow-up too when a Pi without isIdle refuses a plain message mid-run.
    try {
      if (ctx?.isIdle?.() === false) pi.sendUserMessage(reason, { deliverAs: "followUp" });
      else pi.sendUserMessage(reason);
    } catch {
      try { pi.sendUserMessage(reason, { deliverAs: "followUp" }); } catch { /* Pi refused both deliveries. */ }
    }
    return undefined;
  });
}

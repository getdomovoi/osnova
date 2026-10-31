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

// The deferred stop hook in the Codex shape: `decision: "block"` with a reason and the diff's digest when the agent
// should check its change, a `systemMessage` warning otherwise. Only the first is delivered.
function notice(answer: string): { reason: string; digest: string } | undefined {
  try {
    const parsed = JSON.parse(answer) as { decision?: unknown; reason?: unknown; digest?: unknown };
    return parsed.decision === "block" && typeof parsed.reason === "string" && parsed.reason.length > 0 && typeof parsed.digest === "string"
      ? { reason: parsed.reason, digest: parsed.digest } : undefined;
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
  // The notice last sent into each session, to tell it from the user's own prompts.
  const sent = new Map<string, string>();
  // Sessions that got a notice since the user's last prompt: at most one notice per prompt, however Pi runs it.
  const notified = new Set<string>();
  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx?.cwd ?? process.cwd();
    const session = sessionOf(ctx);
    const own = typeof event.prompt === "string" && sent.get(session) === event.prompt;
    if (!own) notified.delete(session);
    contract ??= await hook("session", { cwd }, cwd, "--full-contract");
    // The settle notice this extension sends already names each dependent with its line; it needs no starting points.
    const points = typeof event.prompt === "string" && !own ? await hook("prompt", { prompt: event.prompt, cwd }, cwd) : "";
    const extra = [contract, points].filter((part) => part.length > 0).join("\n\n");
    return extra.length === 0 ? undefined : { systemPrompt: `${event.systemPrompt}\n\n${extra}` };
  });
  // agent_settled is the run's final idle point, after retries and compaction. A run the user aborted gets no notice.
  pi.on("agent_settled", async (event, ctx) => {
    const session = sessionOf(ctx);
    if (event?.aborted === true || notified.has(session)) return undefined;
    const cwd = ctx?.cwd ?? process.cwd();
    const found = notice(await hook("stop", { session_id: session, cwd }, cwd, "--client", "codex", "--defer"));
    if (found === undefined) return undefined;
    // Pi throws for a plain message while a run streams, so a run the user started meanwhile gets it as a follow-up.
    // The hook records the diff only on the acknowledgement, so a notice Pi refuses is offered again next time.
    const deliveries: (() => void)[] = ctx?.isIdle?.() === false ? [] : [() => pi.sendUserMessage(found.reason)];
    deliveries.push(() => pi.sendUserMessage(found.reason, { deliverAs: "followUp" }));
    sent.set(session, found.reason);
    const delivered = deliveries.some((deliver) => { try { deliver(); return true; } catch { return false; } });
    if (!delivered) { sent.delete(session); return undefined; }
    notified.add(session);
    await hook("stop", { session_id: session, cwd }, cwd, "--client", "codex", "--ack", found.digest);
    return undefined;
  });
}

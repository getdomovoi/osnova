// Osnova extension for Pi: the tool contract and starting points for the prompt go into the system
// prompt before each agent run, and the search gate blocks grep and find until osnova has been tried.
// All logic lives in `osnova hook`; this file only shells out to it.
// Install by copying it into ~/.pi/agent/extensions/, or run `osnova setup --apply --client pi --plugin`.
// Set OSNOVA_BIN to run another osnova executable, or OSNOVA_GATE=off to turn the gate off for one run.
// Pi tools reach the graph through pi-mcp-adapter.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const executable = process.env.OSNOVA_BIN ?? "osnova";
// One identity per extension load, so the turn counter the CLI keeps belongs to this Pi session alone.
const sessionId = `pi-${randomUUID()}`;

function hook(event: string, payload: unknown, cwd: string, ...flags: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    try {
      const child = spawn(executable, ["hook", event, ...flags], { cwd, stdio: ["pipe", "pipe", "ignore"] });
      const timer = setTimeout(() => { child.kill(); resolve(""); }, 15_000);
      child.stdout.on("data", (chunk: Buffer | string) => { out += chunk; });
      child.on("error", () => { clearTimeout(timer); resolve(""); });
      child.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
      child.stdin.end(JSON.stringify({ session_id: sessionId, ...(payload as Record<string, unknown>) }));
    } catch { resolve(""); }
  });
}

interface BeforeAgentStart { readonly prompt?: string; readonly systemPrompt: string }
interface ToolCall { readonly toolName: string; readonly input: Record<string, unknown> }
interface ToolCallResult { readonly block?: boolean; readonly reason?: string }
interface Context { readonly cwd?: string }
interface PiApi {
  on(event: "before_agent_start", handler: (event: BeforeAgentStart, ctx: Context) => Promise<{ systemPrompt?: string } | undefined>): void;
  on(event: "tool_call", handler: (event: ToolCall, ctx: Context) => Promise<ToolCallResult | undefined>): void;
}

export default function osnova(pi: PiApi): void {
  let contract: string | undefined;
  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx?.cwd ?? process.cwd();
    contract ??= await hook("session", { cwd }, cwd, "--full-contract");
    // Always sent, prompt or not: this is what opens the next turn for the gate.
    const points = await hook("prompt", { prompt: event.prompt ?? "", cwd }, cwd);
    const extra = [contract, points].filter((part) => part.length > 0).join("\n\n");
    return extra.length === 0 ? undefined : { systemPrompt: `${event.systemPrompt}\n\n${extra}` };
  });

  // The gate. An osnova call records that osnova was tried this turn; every other call is offered to
  // `osnova hook gate`, which answers with nothing (allow) or {"block":true,"reason":"..."}.
  pi.on("tool_call", async (event, ctx) => {
    const cwd = ctx?.cwd ?? process.cwd();
    const payload = { cwd, tool_name: event.toolName, tool_input: event.input };
    if (/(?:^|_)osnova/i.test(event.toolName)) { await hook("mark", payload, cwd, "--client", "pi"); return undefined; }
    const answer = await hook("gate", payload, cwd, "--client", "pi");
    if (answer.length === 0) return undefined;
    try {
      const parsed = JSON.parse(answer) as ToolCallResult;
      return parsed.block === true ? parsed : undefined;
    } catch { return undefined; }
  });
}

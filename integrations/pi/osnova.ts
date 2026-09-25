// Osnova extension for Pi: the tool contract and starting points for the prompt go into the system
// prompt before each agent run. All logic lives in `osnova hook`; this file only shells out to it.
// Install by copying it into ~/.pi/agent/extensions/, or run `osnova setup --apply --client pi --plugin`.
// Set OSNOVA_BIN to run another osnova executable. Pi tools reach the graph through pi-mcp-adapter.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const executable = process.env.OSNOVA_BIN ?? "osnova";

function hook(event: string, payload: unknown, cwd: string, ...flags: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const failed = () => event === "gate" ? reject(new Error("osnova gate unavailable; restore Osnova before repository exploration.")) : resolve("");
    try {
      const child = spawn(executable, ["hook", event, ...flags], { cwd, stdio: ["pipe", "pipe", "ignore"] });
      const timer = setTimeout(() => { child.kill(); failed(); }, 30_000);
      child.stdout.on("data", (chunk: Buffer | string) => { out += chunk; });
      child.on("error", () => { clearTimeout(timer); failed(); });
      child.stdin.on("error", () => { clearTimeout(timer); failed(); });
      child.on("close", (code) => { clearTimeout(timer); if (code !== 0) failed(); else resolve(out.trim()); });
      child.stdin.end(JSON.stringify(payload));
    } catch { failed(); }
  });
}

interface BeforeAgentStart { readonly prompt?: string; readonly systemPrompt: string }
interface Context { readonly cwd?: string; readonly sessionManager?: { getSessionId(): string } }
interface ToolCall { readonly toolName: string; readonly toolCallId?: string | undefined; readonly input: Record<string, unknown> }
interface ToolResult extends ToolCall { readonly content: unknown; readonly isError: boolean }
const queryTools = new Set(["osnova_ground", "osnova_thread", "osnova_outline", "osnova_warp", "osnova_groundwork", "osnova_footing", "osnova_settle", "osnova_plumb", "osnova_tests", "osnova_unreferenced"]);
function call(event: ToolCall): { toolName: string; toolInput: Record<string, unknown> } {
  if (event.toolName !== "mcp" || typeof event.input.tool !== "string" || event.input.server !== undefined && event.input.server !== "osnova") {
    return { toolName: event.toolName, toolInput: event.input };
  }
  const name = event.input.tool.split(/[.:/]/).at(-1)!;
  if (!queryTools.has(name)) return { toolName: event.toolName, toolInput: event.input };
  let args: unknown = event.input.args;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = undefined; }
  }
  return { toolName: name, toolInput: args !== null && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {} };
}
interface PiApi {
  on(event: "before_agent_start", handler: (event: BeforeAgentStart, ctx: Context) => Promise<{ systemPrompt?: string } | undefined>): void;
  on(event: "tool_call", handler: (event: ToolCall, ctx: Context) => Promise<{ block: true; reason: string } | undefined>): void;
  on(event: "tool_result", handler: (event: ToolResult, ctx: Context) => Promise<void>): void;
}

export default function osnova(pi: PiApi): void {
  const contracts = new Map<string, string>();
  const fallbackSession = randomUUID();
  const session = (ctx: Context): string => ctx.sessionManager?.getSessionId() ?? fallbackSession;
  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx?.cwd ?? process.cwd();
    const contract = contracts.get(cwd) ?? await hook("session", { cwd }, cwd, "--full-contract");
    if (contract.length > 0) contracts.set(cwd, contract);
    const points = await hook("prompt", { session_id: session(ctx), prompt: event.prompt, cwd }, cwd);
    const extra = [contract, points].filter((part) => part.length > 0).join("\n\n");
    return extra.length === 0 ? undefined : { systemPrompt: `${event.systemPrompt}\n\n${extra}` };
  });
  pi.on("tool_call", async (event, ctx) => {
    const cwd = ctx.cwd ?? process.cwd();
    const normalized = call(event);
    try {
      const raw = await hook("gate", { session_id: session(ctx), tool_use_id: event.toolCallId, cwd, tool_name: normalized.toolName, tool_input: normalized.toolInput }, cwd, "--client", "pi");
      if (raw.length === 0) return undefined;
      const decision = JSON.parse(raw) as { block?: boolean; reason?: string };
      return { block: true, reason: decision.block === true && typeof decision.reason === "string" ? decision.reason : "osnova gate returned an invalid decision." };
    } catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
  });
  pi.on("tool_result", async (event, ctx) => {
    const normalized = call(event);
    if (!normalized.toolName.includes("osnova_")) return;
    const cwd = ctx.cwd ?? process.cwd();
    await hook("mark", { session_id: session(ctx), tool_use_id: event.toolCallId, cwd, tool_name: normalized.toolName, tool_input: normalized.toolInput, tool_response: { content: event.content, isError: event.isError } }, cwd, "--client", "pi");
  });
}

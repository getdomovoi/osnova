// Osnova extension for Pi: the tool contract and starting points for the prompt go into the system
// prompt before each agent run. All logic lives in `osnova hook`; this file only shells out to it.
// Install by copying it into ~/.pi/agent/extensions/, or run `osnova setup --apply --client pi --plugin`.
// Set OSNOVA_BIN to run another osnova executable. Pi tools reach the graph through pi-mcp-adapter.
import { spawn } from "node:child_process";

const executable = process.env.OSNOVA_BIN ?? "osnova";

function hook(event: string, payload: unknown, cwd: string, ...flags: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    try {
      const child = spawn(executable, ["hook", event, ...flags], { cwd, stdio: ["pipe", "pipe", "ignore"] });
      const timer = setTimeout(() => { child.kill(); resolve(""); }, 15_000);
      child.stdout.on("data", (chunk: Buffer | string) => { out += chunk; });
      child.on("error", () => { clearTimeout(timer); resolve(""); });
      child.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
      child.stdin.end(JSON.stringify(payload));
    } catch { resolve(""); }
  });
}

interface BeforeAgentStart { readonly prompt?: string; readonly systemPrompt: string }
interface Context { readonly cwd?: string }
interface PiApi { on(event: "before_agent_start", handler: (event: BeforeAgentStart, ctx: Context) => Promise<{ systemPrompt?: string } | undefined>): void }

export default function osnova(pi: PiApi): void {
  let contract: string | undefined;
  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx?.cwd ?? process.cwd();
    contract ??= await hook("session", { cwd }, cwd, "--full-contract");
    const points = typeof event.prompt === "string" ? await hook("prompt", { prompt: event.prompt, cwd }, cwd) : "";
    const extra = [contract, points].filter((part) => part.length > 0).join("\n\n");
    return extra.length === 0 ? undefined : { systemPrompt: `${event.systemPrompt}\n\n${extra}` };
  });
}

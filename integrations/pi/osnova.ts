// Osnova extension for Pi: the tool contract and starting points for the prompt go into the system
// prompt before each agent run. All logic lives in `osnova hook`; this file only shells out to it.
// Install by copying it into ~/.pi/agent/extensions/, or run `osnova setup --apply --client pi --plugin`.
// Set OSNOVA_BIN to run another osnova executable. Pi tools reach the graph through pi-mcp-adapter.
import { spawn } from "node:child_process";

const executable = process.env.OSNOVA_BIN ?? "osnova";
// On Windows the osnova command is an npm .cmd shim, which Node starts only through a shell.
const windows = process.platform === "win32";
// cmd.exe reads quotes, &, |, <, >, ^, ! and % in a command line even inside quotes, so such a path is not run.
const unsafeOnWindows = /["%&|<>^!\r\n]/;

function hook(event: string, payload: unknown, cwd: string, ...flags: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    if (windows && unsafeOnWindows.test(executable)) { resolve(""); return; }
    try {
      const child = spawn(windows ? `"${executable}"` : executable, ["hook", event, ...flags], { cwd, stdio: ["pipe", "pipe", "ignore"], shell: windows, windowsHide: true });
      // Through a shell, kill() ends only cmd.exe; taskkill /t also ends the osnova process it started.
      const stop = () => {
        if (windows && child.pid !== undefined) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
        else child.kill();
      };
      const timer = setTimeout(() => { stop(); resolve(""); }, 15_000);
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

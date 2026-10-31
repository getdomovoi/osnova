// Osnova plugin for OpenCode and Kilo: starting points on every user message (the tool contract comes from
// the MCP server's instructions), and at the end of a turn what the uncommitted change reached, posted back into the
// session so the agent checks it. All logic lives in `osnova hook`; this file only shells out to it. Install by
// copying it into ~/.config/opencode/plugins/ (or ~/.config/kilo/plugins/), or run
// `osnova setup --apply --client opencode --plugin`. Set OSNOVA_BIN to run another osnova executable.
import { spawn } from "node:child_process";

const executable = process.env.OSNOVA_BIN ?? "osnova";
// On Windows the osnova command is an npm .cmd shim, which Node starts only through a shell.
const windows = process.platform === "win32";
// Inside double quotes cmd.exe reads &, |, <, >, and ^ literally, but a quote ends the quoting and % or ! expands
// a variable, so a path holding one of those, or a line break, is not run.
const unsafeOnWindows = /["%!\r\n]/;

function hook(event, payload, cwd, ...flags) {
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
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("error", () => { clearTimeout(timer); resolve(""); });
      child.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
      child.stdin.end(JSON.stringify(payload));
    } catch { resolve(""); }
  });
}

// The stop hook in the Codex shape: `decision: "block"` with a reason when the agent should check its change, a
// `systemMessage` warning otherwise. Only the first continues the session.
function continueReason(answer) {
  try {
    const parsed = JSON.parse(answer);
    return parsed?.decision === "block" && typeof parsed.reason === "string" && parsed.reason.length > 0 ? parsed.reason : undefined;
  } catch { return undefined; }
}

export const OsnovaPlugin = async ({ directory, worktree, client }) => {
  const cwd = worktree || directory || process.cwd();
  // A subagent runs in a child session; its idle is not the end of the user's turn, so it gets no notice.
  const children = new Set();
  // Sessions whose running turn the posted notice started: their idle is a stop hook continuation, which the hook
  // never continues again. A user prompt clears the mark.
  const noticed = new Set();
  // Sessions whose turn the user aborted: their next idle gets no notice.
  const aborted = new Set();
  // Bumped on every user prompt, so a notice computed while the user started a new turn is dropped.
  const prompts = new Map();
  const prompted = (sessionID) => { prompts.set(sessionID, (prompts.get(sessionID) ?? 0) + 1); noticed.delete(sessionID); };
  const settle = async (sessionID) => {
    const before = prompts.get(sessionID) ?? 0;
    const continuation = noticed.delete(sessionID);
    const reason = continueReason(await hook("stop", { session_id: sessionID, cwd, ...(continuation ? { stop_hook_active: true } : {}) }, cwd, "--client", "codex"));
    if (reason === undefined || (prompts.get(sessionID) ?? 0) !== before) return;
    noticed.add(sessionID);
    await client.session.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: "text", text: reason }] } }).catch(() => { noticed.delete(sessionID); });
  };
  // OpenCode and Kilo already put the MCP server's instructions (the tool contract) into the system prompt, so the
  // session hook's text is dropped; it still runs once, first, because on a cold cache it starts the index build.
  let warm;
  return {
    "chat.message": async (input, output) => {
      warm ??= hook("session", { cwd }, cwd);
      await warm;
      const text = output.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
      // The settle notice this plugin posts already names each dependent with its line; it needs no starting points.
      if (text.startsWith("[osnova settle]")) return;
      if (typeof input?.sessionID === "string") prompted(input.sessionID);
      if (text.trim().length === 0) return;
      const points = await hook("prompt", { prompt: text, cwd }, cwd);
      if (points.length === 0) return;
      const last = output.parts.filter((part) => part.type === "text").at(-1);
      if (last !== undefined) last.text = `${last.text}\n\n${points}`;
    },
    // session.idle is the end of a turn. The check runs in the background so later events are not held behind it.
    event: async ({ event }) => {
      const type = event?.type;
      const info = event?.properties?.info;
      // Messages carry their session's id as parentID too, so only session events name a child session.
      if (typeof type === "string" && type.startsWith("session.") && typeof info?.id === "string" && typeof info.parentID === "string") children.add(info.id);
      const sessionID = event?.properties?.sessionID;
      if (typeof sessionID !== "string") return;
      if (type === "session.error" && event.properties?.error?.name === "MessageAbortedError") { aborted.add(sessionID); return; }
      if (type !== "session.idle" || children.has(sessionID) || typeof client?.session?.promptAsync !== "function") return;
      if (aborted.delete(sessionID)) { noticed.delete(sessionID); return; }
      void settle(sessionID).catch(() => undefined);
    },
  };
};

export default OsnovaPlugin;

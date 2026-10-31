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

// The deferred stop hook in the Codex shape: `decision: "block"` with a reason and the diff's digest when the agent
// should check its change, a `systemMessage` warning otherwise. Only the first is delivered.
function notice(answer) {
  try {
    const parsed = JSON.parse(answer);
    return parsed?.decision === "block" && typeof parsed.reason === "string" && parsed.reason.length > 0 && typeof parsed.digest === "string"
      ? { reason: parsed.reason, digest: parsed.digest } : undefined;
  } catch { return undefined; }
}

export const OsnovaPlugin = async ({ directory, worktree, client }) => {
  const cwd = worktree || directory || process.cwd();
  // A subagent runs in a child session; its idle is not the end of the user's turn, so it gets no notice.
  const children = new Set();
  // The notice last posted into each session, to tell it from the user's own messages.
  const posted = new Map();
  // Sessions that got a notice since the user's last prompt: at most one notice per prompt, however the turns run.
  const notified = new Set();
  // Sessions the user aborted: no notice until the user prompts again (Kilo fires two idles after an abort).
  const aborted = new Set();
  // One stop check per session at a time; an idle during a check runs one more check after it.
  const checking = new Set();
  const again = new Set();
  const forget = (sessionID) => { for (const marks of [children, posted, notified, aborted, again]) marks.delete(sessionID); };
  const settle = async (sessionID) => {
    if (checking.has(sessionID)) { again.add(sessionID); return; }
    checking.add(sessionID);
    try {
      do {
        again.delete(sessionID);
        if (notified.has(sessionID) || aborted.has(sessionID)) return;
        const found = notice(await hook("stop", { session_id: sessionID, cwd }, cwd, "--client", "codex", "--defer"));
        if (found === undefined) continue;
        // Kilo queues a prompt sent during a turn and runs it after that turn ends. The hook records the diff only on
        // the acknowledgement, so a notice that fails to post is offered again at the next idle.
        // Marked before the post, so a user prompt that arrives while it is in flight clears the mark for its own turn.
        posted.set(sessionID, found.reason);
        notified.add(sessionID);
        const delivered = await client.session.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: "text", text: found.reason }] } }).then(() => true, () => false);
        if (!delivered) { posted.delete(sessionID); notified.delete(sessionID); continue; }
        await hook("stop", { session_id: sessionID, cwd }, cwd, "--client", "codex", "--ack", found.digest);
      } while (again.has(sessionID));
    } finally { checking.delete(sessionID); }
  };
  // OpenCode and Kilo already put the MCP server's instructions (the tool contract) into the system prompt, so the
  // session hook's text is dropped; it still runs once, first, because on a cold cache it starts the index build.
  let warm;
  return {
    // Kilo calls this when a message is queued, before its turn starts.
    "chat.message": async (input, output) => {
      const text = output.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
      const sessionID = typeof input?.sessionID === "string" ? input.sessionID : undefined;
      // Another plugin may already have appended to the posted notice, so it is recognized by how it starts.
      const notice = sessionID === undefined ? undefined : posted.get(sessionID);
      const own = notice !== undefined && text.startsWith(notice);
      // Each notice is recognized once; a later message that pastes it back is the user's.
      if (own) posted.delete(sessionID);
      else if (sessionID !== undefined) { notified.delete(sessionID); aborted.delete(sessionID); }
      warm ??= hook("session", { cwd }, cwd);
      await warm;
      // The settle notice this plugin posts already names each dependent with its line; it needs no starting points.
      if (own || text.trim().length === 0) return;
      const points = await hook("prompt", { prompt: text, cwd }, cwd);
      if (points.length === 0) return;
      const last = output.parts.filter((part) => part.type === "text").at(-1);
      if (last !== undefined) last.text = `${last.text}\n\n${points}`;
    },
    // session.idle is the end of a turn. The check runs in the background so later events are not held behind it.
    event: async ({ event }) => {
      const type = event?.type;
      const info = event?.properties?.info;
      if (type === "session.deleted" && typeof info?.id === "string") { forget(info.id); return; }
      // Messages carry their session's id as parentID too, so only session events name a child session.
      if (typeof type === "string" && type.startsWith("session.") && typeof info?.id === "string" && typeof info.parentID === "string") children.add(info.id);
      const sessionID = event?.properties?.sessionID;
      if (typeof sessionID !== "string" || children.has(sessionID)) return;
      if (type === "session.error" && event.properties?.error?.name === "MessageAbortedError") { aborted.add(sessionID); return; }
      if (type !== "session.idle" || typeof client?.session?.promptAsync !== "function") return;
      void settle(sessionID).catch(() => undefined);
    },
  };
};

export default OsnovaPlugin;

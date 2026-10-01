// Records the getosnova.dev film in real time through the DevTools screencast.
// Usage: node scripts/record-film.mjs <url> <outDir> [cssWidth=1440] [scale=1.84]
// Set CHROME to a Chromium-family browser binary; the default is Brave on macOS.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [url, outArg, cssWidth = "1440", scale = "1.84"] = process.argv.slice(2);
// ffmpeg resolves concat entries against concat.txt's folder, so frame paths must be absolute.
const outDir = path.resolve(outArg);
const port = 9347;
const profile = path.join(outDir, "profile");
fs.mkdirSync(path.join(outDir, "frames"), { recursive: true });

const brave = spawn(process.env.CHROME ?? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--hide-scrollbars", `--force-device-scale-factor=${scale}`, `--window-size=${cssWidth},${Math.round(Number(cssWidth) * 0.62)}`, "--mute-audio", "--no-first-run", "--disable-features=Translate", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => delay(ms);
let ws;
try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) {
    await sleep(200);
    targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => undefined);
  }
  const page = targets?.find((t) => t.type === "page");
  if (!page) throw new Error(`no DevTools page on port ${port}`);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));

  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) for (const fn of listeners) fn(msg);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;

  const width = Number(cssWidth);
  const dsf = Number(scale);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height: Math.round(width * 0.62), deviceScaleFactor: 0, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "no-preference" }] });
  await send("Page.navigate", { url });
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    if (await evaluate("document.readyState === 'complete'")) break;
  }
  await evaluate("document.fonts.ready.then(() => true)");
  await evaluate("document.querySelector('.film-frame').scrollIntoView({ block: 'center' }), true");
  await sleep(1500);
  const rect = await evaluate("(() => { const r = document.querySelector('.film-frame')?.getBoundingClientRect(); return r && { x: r.x, y: r.y, w: r.width, h: r.height }; })()");
  if (!rect) throw new Error(`no .film-frame on ${url}`);

  const frames = [];
  listeners.push(async (msg) => {
    if (msg.method !== "Page.screencastFrame") return;
    const { data, metadata, sessionId } = msg.params;
    send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    const file = path.join(outDir, "frames", `${String(frames.length).padStart(5, "0")}.png`);
    frames.push({ file, ts: metadata.timestamp });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
  });
  await send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: Math.round(width * dsf), maxHeight: Math.round(width * 0.62 * dsf) });
  await sleep(400);
  await evaluate("document.querySelector('[data-film-chips] .chip').click(), true");
  const t0 = Date.now();
  let finished = false;
  while (!finished && Date.now() - t0 < 60000) {
    await sleep(250);
    finished = await evaluate("document.querySelector('[data-film-toggle]').textContent === 'Replay'");
  }
  if (!finished) throw new Error("the film did not finish within 60 s");
  await sleep(2500);
  await send("Page.stopScreencast");
  await sleep(300);

  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const next = frames[i + 1]?.ts ?? frames[i].ts + 1 / 30;
    lines.push(`file '${frames[i].file}'`, `duration ${Math.max(0.001, next - frames[i].ts).toFixed(4)}`);
  }
  lines.push(`file '${frames.at(-1).file}'`);
  fs.writeFileSync(path.join(outDir, "concat.txt"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify({ rect, dsf, frames: frames.length, seconds: frames.at(-1).ts - frames[0].ts }, null, 2));
  console.log(JSON.stringify({ rect, dsf, frames: frames.length, seconds: (frames.at(-1).ts - frames[0].ts).toFixed(2) }));
} finally {
  ws?.close();
  brave.kill();
}

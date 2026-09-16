import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

const checkout = fileURLToPath(new URL("../", import.meta.url));
const scratch = await mkdtemp(path.join(os.tmpdir(), "osnova-clean-install-"));
try {
  const home = path.join(scratch, "home");
  const consumer = path.join(scratch, "consumer");
  await mkdir(home);
  await mkdir(consumer);
  const environment = { ...process.env, HOME: home, USERPROFILE: home, npm_config_update_notifier: "false",
    npm_config_userconfig: path.join(home, ".npmrc"), npm_config_globalconfig: path.join(home, "global-npmrc") };
  const windows = process.platform === "win32";
  const npm = (args, options) => execFileSync(windows ? "npm.cmd" : "npm", windows ? args.map((arg) => `"${arg}"`) : args, { ...options, shell: windows });
  const packed = npm(["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], {
    cwd: checkout, encoding: "utf8", timeout: 60_000, env: environment,
  });
  const [{ filename }] = JSON.parse(packed);
  await writeFile(path.join(consumer, "package.json"), '{"name":"osnova-clean-consumer","private":true,"type":"module"}\n');
  npm(["install", path.join(scratch, filename), "--ignore-scripts", "--no-audit", "--no-fund", "--cache", path.join(scratch, "npm-cache")], {
    cwd: consumer, encoding: "utf8", timeout: 180_000, env: environment,
  });
  await cp(path.join(checkout, "scripts/package-smoke.mjs"), path.join(consumer, "package-smoke.mjs"));
  await cp(path.join(checkout, "scripts/check-package.mjs"), path.join(consumer, "check-package.mjs"));
  const output = execFileSync(process.execPath, [path.join(consumer, "package-smoke.mjs"), "--consumer"], {
    cwd: consumer, encoding: "utf8", timeout: 60_000,
    env: { ...environment, NODE_PATH: "", NODE_OPTIONS: "", OSNOVA_CACHE_DIR: path.join(consumer, "cache") },
  });
  assert(output.includes("packed consumer: exports, 20 WASM grammars"));
  process.stdout.write(output);
  process.stdout.write("clean registry-backed install: passed; dependency install scripts disabled\n");
} finally {
  await rm(scratch, { recursive: true, force: true });
}

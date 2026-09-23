import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OSNOVA_VERSION } from "../version.js";
import { resolveCacheDir } from "../cache/cache.js";
import { familySiblings, workspaceFamily } from "../cache/family.js";
import { getParser } from "../grammar/loader.js";
import { extensionLanguage, grammarFile, languageTier } from "../grammar/languages.js";
import type { LanguageId } from "../types.js";
import { pluginClients, pluginSource, pluginTarget, skillSource, skillTarget } from "./setup-apply.js";

export interface DiagnosticCheck {
  readonly id: string;
  readonly status: "ok" | "warning" | "error";
  readonly message: string;
}

export interface LanguageCapability {
  readonly language: LanguageId;
  readonly extensions: readonly string[];
  readonly status: "ok" | "error";
  readonly extraction: "syntax" | "tags";
  readonly resolution: "binding-and-receiver-hints" | "name-heuristics";
  readonly typeInference: false;
  readonly limitations: readonly string[];
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly readOnly: true;
  readonly checks: readonly DiagnosticCheck[];
  readonly capabilities: readonly LanguageCapability[];
  readonly fallback: string;
}

export interface DoctorOptions {
  readonly cacheDir?: string | undefined;
  /** Where client configs are read for the version check; defaults to the home directory. */
  readonly home?: string | undefined;
}

const packageName = "@getdomovoi/osnova";

async function readManifest(file: string): Promise<{ name?: unknown; version?: unknown } | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return typeof value === "object" && value !== null ? value as { name?: unknown; version?: unknown } : undefined;
  } catch { return undefined; }
}

async function osnovaManifest(dir: string): Promise<{ root: string; version: string } | undefined> {
  const manifest = await readManifest(path.join(dir, "package.json"));
  return manifest?.name === packageName && typeof manifest.version === "string" ? { root: dir, version: manifest.version } : undefined;
}

async function onPath(name: string): Promise<string | undefined> {
  if (name.includes("/") || name.includes("\\")) return path.resolve(name);
  const extensions = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
    }
  }
  return undefined;
}

// The osnova install a configured command would start, found by reading files only: the nearest package.json
// above the resolved script, or the package beside a node_modules/.bin or npm prefix shim.
async function installBehind(executable: string, args: readonly string[]): Promise<{ root: string; version: string } | undefined> {
  const script = /^node(\.exe)?$/i.test(path.basename(executable)) ? args.find((arg) => !arg.startsWith("-")) : executable;
  if (script === undefined) return undefined;
  const located = await onPath(script);
  const real = located === undefined ? undefined : await realpath(located).catch(() => undefined);
  if (real === undefined) return undefined;
  const dir = path.dirname(real);
  for (let current = dir; ; current = path.dirname(current)) {
    if (await stat(path.join(current, "package.json")).then(() => true, () => false)) {
      const found = await osnovaManifest(current);
      if (found !== undefined) return found;
      break;
    }
    if (path.dirname(current) === current) break;
  }
  return osnovaManifest(path.basename(dir) === ".bin" ? path.join(dir, "..", "@getdomovoi", "osnova") : path.join(dir, "node_modules", "@getdomovoi", "osnova"));
}

// Every osnova command a Claude Code config runs (hooks in ~/.claude/settings.json, the MCP server in ~/.claude.json)
// must come from this version; a hook or server from another install would read caches this one writes.
// The check reads the install's package.json and never runs the configured command: the command comes from a
// user-writable JSON file, and doctor reports itself read-only.
export async function clientVersionChecks(home: string): Promise<DiagnosticCheck[]> {
  const commands = new Map<string, string[]>();
  const note = (command: string, role: string): void => { const roles = commands.get(command) ?? []; if (!roles.includes(role)) roles.push(role); commands.set(command, roles); };
  const read = async (file: string): Promise<unknown> => { try { return JSON.parse(await readFile(file, "utf8")); } catch { return undefined; } };
  const settings = await read(path.join(home, ".claude", "settings.json")) as { hooks?: Record<string, unknown> } | undefined;
  for (const groups of Object.values(settings?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) for (const hook of (group as { hooks?: unknown[] })?.hooks ?? []) {
      const command = (hook as { command?: unknown })?.command;
      if (typeof command === "string" && /osnova/.test(command) && /\bhook\b/.test(command)) note(command.replace(/\s+hook\b.*$/, ""), "hook");
    }
  }
  const claude = await read(path.join(home, ".claude.json")) as { mcpServers?: Record<string, { command?: unknown; args?: unknown }> } | undefined;
  const server = claude?.mcpServers?.osnova;
  if (server !== undefined && typeof server.command === "string") {
    const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === "string") : [];
    const prefix = [server.command, ...args.slice(0, Math.max(0, args.indexOf("mcp")))];
    note(prefix.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" "), "mcp");
  }
  if (commands.size === 0) return [{ id: "clients", status: "ok", message: "No Claude Code hook or MCP entry references osnova; nothing to compare." }];
  const checks: DiagnosticCheck[] = [];
  for (const [command, roles] of commands) {
    const role = roles.join("+");
    const parts = command.match(/"[^"]*"|\S+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
    const [executable, ...args] = parts;
    if (executable === undefined) continue;
    const spec = args.map((arg) => new RegExp(`^${packageName}@(\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?)$`).exec(arg)?.[1]).find((version) => version !== undefined);
    const install = spec === undefined ? await installBehind(executable, args) : undefined;
    const version = spec ?? install?.version;
    if (version === undefined) {
      checks.push({ id: `client:${role}`, status: "warning", message: `${command} does not resolve to an osnova install this check can read; its version is unknown. Doctor does not run configured commands.` });
      continue;
    }
    const source = install === undefined ? "names" : `resolves to ${install.root}, which is`;
    checks.push(version === OSNOVA_VERSION
      ? { id: `client:${role}`, status: "ok", message: `${command} ${source} osnova ${version}, the same as this osnova.` }
      : { id: `client:${role}`, status: "warning", message: `${command} ${source} osnova ${version}; this osnova is ${OSNOVA_VERSION}. Hooks, server and caches should come from one install.` });
  }
  return checks;
}

// The plugin and skill files osnova setup copies: present and identical to what this osnova ships, or
// present and different (an older osnova, or a hand edit), which is what "setup --apply" refuses to overwrite.
export async function integrationFileChecks(home: string): Promise<DiagnosticCheck[]> {
  const entries = [
    ...pluginClients.map((client) => ({ id: `plugin:${client}`, target: pluginTarget(client, home), source: pluginSource(client), fix: `osnova setup --apply --client ${client} --plugin` })),
    { id: "skill:claude-code", target: skillTarget(home), source: skillSource(), fix: "osnova setup --apply --skill" },
  ];
  const checks: DiagnosticCheck[] = [];
  const normalized = (text: string): string => text.replace(/\r\n/g, "\n");
  for (const entry of entries) {
    const installed = await readFile(entry.target, "utf8").catch(() => undefined);
    if (installed === undefined) continue;
    const shipped = await readFile(entry.source, "utf8").catch(() => undefined);
    if (shipped === undefined) { checks.push({ id: entry.id, status: "warning", message: `${entry.target} is installed but this osnova ships no such file.` }); continue; }
    checks.push(normalized(installed) === normalized(shipped)
      ? { id: entry.id, status: "ok", message: `${entry.target} matches the file this osnova ships.` }
      : { id: entry.id, status: "warning", message: `${entry.target} differs from the file this osnova ships; remove it and run ${entry.fix} to refresh it.` });
  }
  if (checks.length === 0) checks.push({ id: "integrations", status: "ok", message: "No osnova plugin or skill file is installed for OpenCode, Kilo, Pi or Claude Code." });
  return checks;
}

async function familyCheck(workspace: string, cache: string): Promise<DiagnosticCheck> {
  const family = await workspaceFamily(path.resolve(workspace));
  if (family === undefined) {
    return { id: "cache:family", status: "ok", message: "Workspace is not the top level of a git worktree; no cache family, so a first build starts cold." };
  }
  let siblings: string[];
  try {
    siblings = (await familySiblings(cache, path.resolve(workspace), family)).map((sibling) => sibling.root);
  } catch (error) {
    return { id: "cache:family", status: "warning", message: `Cache family ${family}; sibling caches could not be listed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return {
    id: "cache:family", status: "ok",
    message: siblings.length === 0
      ? `Cache family ${family} (git common dir); no sibling worktree cache, so a first build starts cold.`
      : `Cache family ${family} (git common dir); ${siblings.length} sibling worktree cache${siblings.length === 1 ? "" : "s"} a first build may seed from: ${siblings.join(", ")}.`,
  };
}

export async function doctor(workspace: string, options: DoctorOptions = {}): Promise<DoctorReport> {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const runtimeOk = major > 22 || (major === 22 && minor >= 13);
  const checks: DiagnosticCheck[] = [{
    id: "runtime", status: runtimeOk ? "ok" : "error",
    message: `Node ${process.versions.node}; requires >=22.13.0. Platform ${process.platform}/${process.arch}.`,
  }];
  try {
    if (!(await stat(path.resolve(workspace))).isDirectory()) throw new Error("not-directory");
    await access(path.resolve(workspace), constants.R_OK | constants.X_OK);
    checks.push({ id: "workspace", status: "ok", message: "Workspace directory is readable and searchable; source files were not scanned." });
  } catch {
    checks.push({ id: "workspace", status: "error", message: "Workspace is missing, not a directory, or inaccessible." });
  }
  const cache = path.resolve(resolveCacheDir(options.cacheDir));
  let candidate = cache;
  try {
    while (true) {
      try {
        if (!(await stat(candidate)).isDirectory()) throw new Error("not-directory");
        await access(candidate, constants.R_OK | constants.W_OK | constants.X_OK);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(candidate);
        if (parent === candidate) throw error;
        candidate = parent;
      }
    }
    checks.push({
      id: "cache", status: candidate === cache ? "ok" : "warning",
      message: candidate === cache
        ? "Cache directory access checks succeeded. No write probe performed; capacity, atomic publication and artifact validity are unverified."
        : "Cache is absent; nearest existing ancestor permits access. No directory created; actual write capability and capacity are unverified.",
    });
  } catch {
    checks.push({ id: "cache", status: "error", message: "Cache path or its existing ancestor is not an accessible writable directory. No writes attempted." });
  }
  checks.push(await familyCheck(workspace, cache));
  const samples: Record<LanguageId, string> = {
    typescript: "function probe(): number { return 1; }",
    tsx: "const probe = <div />;",
    javascript: "function probe() { return 1; }",
    python: "def probe():\n    return 1\n",
    go: "package probe\nfunc Probe() {}\n",
    rust: "fn probe() {}",
    java: "class Probe { void probe() {} }",
    c_sharp: "class Probe { void Run() {} }",
    c: "int probe() { return 1; }",
    cpp: "int probe() { return 1; }",
    objc: "@interface Probe\n- (int)probe;\n@end\n",
    ruby: "def probe\n  1\nend\n",
    php: "<?php\nfunction probe() { return 1; }\n",
    kotlin: "fun probe(): Int { return 1 }",
    swift: "func probe() -> Int { return 1 }",
    scala: "object Probe { def probe(): Int = 1 }",
    dart: "int probe() { return 1; }",
    elixir: "defmodule Probe do\n  def probe do\n    1\n  end\nend\n",
    ocaml: "let probe () = 1",
    zig: "fn probe() i32 { return 1; }",
    bash: "probe() { echo 1; }",
  };
  const genericLimitations: readonly string[] = [
    "Definitions and bare call names come from a tags query; imports, exports, bindings and receivers are not analyzed.",
    "Name-based resolution can be ambiguous or incomplete.",
    "No binding-aware receiver identity or runtime dispatch proof.",
  ];
  const extraLimitations: Partial<Record<LanguageId, readonly string[]>> = {
    dart: ["Call edges are not extracted for Dart; the tags query only records definitions."],
  };
  const capabilities: LanguageCapability[] = [];
  for (const language of Object.keys(grammarFile).sort() as LanguageId[]) {
    let status: "ok" | "error" = "ok";
    try {
      const parser = await getParser(language);
      const tree = parser.parse(samples[language]);
      try {
        if (!tree || tree.rootNode.hasError) status = "error";
      } finally {
        tree?.delete();
      }
    } catch {
      status = "error";
    }
    const generic = languageTier[language] === "generic";
    const bindingHints = ["typescript", "tsx", "javascript", "python"].includes(language);
    capabilities.push({
      language, status,
      extensions: Object.entries(extensionLanguage).filter(([, value]) => value === language).map(([ext]) => ext).sort(),
      extraction: generic ? "tags" : "syntax",
      resolution: bindingHints ? "binding-and-receiver-hints" : "name-heuristics",
      typeInference: false,
      limitations: generic
        ? [...genericLimitations, ...(extraLimitations[language] ?? [])]
        : bindingHints
          ? ["Hints are not runtime type proofs.", "Dynamic dispatch, arbitrary value flow and inheritance are not resolved.", "Ambiguous or unsupported bindings remain unresolved."]
          : ["Name-based resolution can be ambiguous or incomplete.", "No binding-aware receiver identity or runtime dispatch proof."],
    });
    checks.push({ id: `grammar:${language}`, status, message: status === "ok" ? "Packaged WASM loaded and parsed a synthetic snippet without syntax errors." : "WASM load or synthetic parse failed; check installed parser and grammar assets. No download attempted." });
  }
  const home = path.resolve(options.home ?? os.homedir());
  checks.push(...(await clientVersionChecks(home)), ...(await integrationFileChecks(home)));
  return {
    ok: checks.every((check) => check.status !== "error"), readOnly: true, checks, capabilities,
    fallback: "Other eligible text files receive file cards without structural extraction. Declaration files may be excluded; scan eligibility is separate from grammar availability.",
  };
}

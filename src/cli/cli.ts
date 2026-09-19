import path from "node:path";
import { promises as fs } from "node:fs";
import { parseArgs } from "node:util";
import { buildIndex } from "../index/build.js";
import { hookClients, runHook, workspaceRootFor } from "./hook.js";
import type { HookClient } from "./hook.js";
import type { PluginClient } from "../diagnostics/setup-apply.js";
import { refreshWorkspace } from "../api.js";
import { indexHealth } from "../index/health.js";
import { loadArtifact } from "../index/serialize.js";
import { resolveCacheDir } from "../cache/cache.js";
import { ask } from "../query/ask.js";
import { findTextDetailed } from "../query/findText.js";
import { skeleton } from "../query/skeleton.js";
import { callersDetailed } from "../query/callers.js";
import { map } from "../query/map.js";
import { formatAsk, formatCallersDetailed, formatCoverage, formatFindTextResult, formatPlumb, formatIndexDiagnostics, formatMap, formatSkeleton } from "../query/format.js";
import { resolutionCoverage } from "../query/coverage.js";
import { plumb, parseClaims } from "../query/plumb.js";
import type { OsnovaIndex } from "../types.js";
import { boundText, maximumPlumbCodeUnits } from "../query/budget.js";
import { scopedAsk } from "../query/scoped.js";
import { impact } from "../query/impact.js";
import { taskContext } from "../query/task-context.js";
import { maximumTextResponseCodeUnits } from "../types.js";
import { doctor, setupClients } from "../diagnostics/index.js";
import type { SetupClientId } from "../diagnostics/index.js";
import { OSNOVA_VERSION } from "../version.js";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** The hook payload; defaults to reading the process's stdin. */
  readonly stdin?: (() => Promise<string>) | undefined;
}

const USAGE = `osnova: deterministic repository context engine

usage:
  osnova --version
  osnova build <root> [--cache-dir <path>]
  osnova check <root> [--cache-dir <path>]
  osnova ground "<question>" [--in <path>] [-n <n>] [--full] [--scoped] [--workspace <path>] [--cache-dir <path>]
  osnova thread "<pattern>" [--fixed] [-i] [--in <path>] [-n <n>] [--workspace <path>] [--cache-dir <path>]
  osnova outline <file> [--workspace <path>] [--cache-dir <path>]
  osnova warp <symbol> [--direction in|out] [--depth <n>] [--workspace <path>] [--cache-dir <path>]
  osnova groundwork [--max-dirs <n>] [--workspace <path>] [--cache-dir <path>]
  osnova footing "<question>" [--task understand|change|review] [--symbol <qualified>] [--in <path>] [--workspace <path>] [--cache-dir <path>]
  osnova settle --base-cache <path> [--depth <n>] [--workspace <path>] [--cache-dir <path>]
  osnova coverage [--json] [--workspace <path>] [--cache-dir <path>]
  osnova plumb <symbol> --site <path:line> [--site ...] [--sites-file <path>] [--direction in|out] [--depth <n>] [--workspace <path>] [--cache-dir <path>]
  osnova doctor [--workspace <path>] [--cache-dir <path>]
  osnova setup <--preview|--apply> [--client <claude-code|codex|opencode|kilo|cursor|pi>] [--hooks [--nudge]] [--plugin] [--skill] [--instructions <AGENTS.md>] [--config <path>] [--command <exe>] [--home <path>]
  osnova hook <prompt|session|stop|tool|install-preview> [--client <claude-code|codex|cursor>] [--nudge] [--workspace <path>] [--cache-dir <path>] [--command <exe>]   (editor hooks; payload on stdin)
  osnova mcp [--workspace <path>] [--cache-dir <path>] [--watch]   (default workspace: current directory)
  osnova update-check [--json]   (the only command that opens a network connection; asks the npm registry for the latest version)

queries refresh the index first so answers describe current disk state.`;

const EXIT_OK = 0;
const EXIT_STALE = 1;
const EXIT_ERROR = 2;

async function ensureIndex(
  workspace: string,
  cacheDir?: string,
  warn?: (text: string) => void,
): Promise<OsnovaIndex> {
  const index = await refreshWorkspace(workspace, { cacheDir });
  const diagnostics = formatIndexDiagnostics(index);
  if (diagnostics.length > 0) warn?.(diagnostics);
  return index;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function requirePositional(values: readonly string[], name: string, command: string): string {
  const value = values[0];
  if (value === undefined || value.length === 0) {
    throw new Error(`osnova ${command}: missing <${name}> argument`);
  }
  return value;
}

function numericOption(value: string | undefined, name: string, minimum = 0): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new RangeError(`osnova: --${name} must be a safe integer >= ${minimum}`);
  }
  return number;
}

function jsonOutput(value: unknown, label: string): string {
  const text = JSON.stringify(value);
  if (text.length > maximumTextResponseCodeUnits) {
    throw new RangeError(`osnova: ${label} JSON exceeds ${maximumTextResponseCodeUnits} code units; use the API for complete structured output`);
  }
  return text;
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = { stdout: (t) => process.stdout.write(t + "\n"), stderr: (t) => process.stderr.write(t + "\n") },
): Promise<number> {
  const rawIo = io;
  io = {
    stdout: (text) => rawIo.stdout(boundText(text)),
    stderr: (text) => rawIo.stderr(boundText(text)),
    stdin: rawIo.stdin,
  };
  const [command = "", ...rest] = argv;
  if (command === "--version" || command === "-v" || command === "version") {
    io.stdout(OSNOVA_VERSION);
    return EXIT_OK;
  }
  if (command.length === 0 || command === "--help" || command === "-h" || command === "help") {
    io.stdout(USAGE);
    return command.length === 0 ? EXIT_ERROR : EXIT_OK;
  }

  switch (command) {
    case "build": {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { "cache-dir": { type: "string" } },
      });
      const root = requirePositional(parsed.positionals, "root", "build");
      const cacheDir = parsed.values["cache-dir"];
      const started = Date.now();
      const index = await buildIndex(root, { cacheDir });
      const diagnostics = formatIndexDiagnostics(index);
      if (diagnostics.length > 0) io.stderr(diagnostics);
      const ms = Date.now() - started;
      io.stdout(
        `built index for ${index.root}: ${index.files.size} files, ${index.symbols.size} symbols, ${index.edges.length} edges in ${ms}ms`,
      );
      return EXIT_OK;
    }
    case "check": {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { "cache-dir": { type: "string" } },
      });
      const root = requirePositional(parsed.positionals, "root", "check");
      const cacheDir = resolveCacheDir(parsed.values["cache-dir"]);
      const absRoot = path.resolve(root);
      const loaded = await loadArtifact(absRoot, cacheDir);
      if (loaded === undefined) {
        io.stderr(`osnova check: no index artifact for ${absRoot}; run \`osnova build ${root}\` first`);
        return EXIT_STALE;
      }
      const health = await indexHealth(loaded);
      if (health.state === "fresh") {
        io.stdout("fresh");
        return EXIT_OK;
      }
      const report = health.freshness;
      const stale = report === null ? [] : [...report.added, ...report.changed, ...report.deleted];
      io.stderr([
        `${health.state}: ${stale.length} changed file(s): ${stale.join(", ")}`,
        ...health.diagnostics.map((diagnostic) => `${diagnostic.phase} ${diagnostic.path}: ${diagnostic.code}`),
      ].join("\n"));
      return EXIT_STALE;
    }
    case "ground": {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          in: { type: "string" },
          limit: { type: "string", short: "n" },
          full: { type: "boolean" },
          scoped: { type: "boolean" },
          workspace: { type: "string" },
          "cache-dir": { type: "string" },
        },
      });
      const question = parsed.positionals.join(" ").trim();
      if (question.length === 0) throw new Error("osnova ground: missing <question> argument");
      const index = await ensureIndex(parsed.values.workspace ?? process.cwd(), parsed.values["cache-dir"], io.stderr);
      const limitValue = numericOption(parsed.values.limit, "limit");
      if (parsed.values.scoped === true) {
        const result = scopedAsk(index, question, { in: parsed.values.in, limit: limitValue, full: parsed.values.full });
        io.stdout(`osnova generation ${result.receipt.generation}; ${result.scopes.length} scopes; ${result.omittedHits} hits omitted\n` +
          result.hits.map((hit) => `[${hit.scope || "."}] ${hit.file}:${hit.line} ${hit.symbol?.qualifiedName ?? "<file>"}\n${hit.excerpt}`).join("\n\n"));
        return EXIT_OK;
      }
      const result = ask(index, question, {
        in: parsed.values.in,
        limit: limitValue,
        full: parsed.values.full,
      });
      io.stdout(formatAsk(result));
      return EXIT_OK;
    }
    case "thread": {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          fixed: { type: "boolean" },
          "ignore-case": { type: "boolean", short: "i" },
          in: { type: "string" },
          limit: { type: "string", short: "n" },
          workspace: { type: "string" },
          "cache-dir": { type: "string" },
        },
      });
      const pattern = requirePositional(parsed.positionals, "pattern", "grep");
      const index = await ensureIndex(parsed.values.workspace ?? process.cwd(), parsed.values["cache-dir"], io.stderr);
      const limitValue = numericOption(parsed.values.limit, "limit");
      const result = findTextDetailed(index, pattern, {
        fixed: parsed.values.fixed,
        ignoreCase: parsed.values["ignore-case"],
        in: parsed.values.in,
        limit: limitValue ?? 50,
        matchesPerGroup: 10,
      });
      io.stdout(formatFindTextResult(result));
      return EXIT_OK;
    }
    case "outline": {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { workspace: { type: "string" }, "cache-dir": { type: "string" } },
      });
      const file = requirePositional(parsed.positionals, "file", "skeleton");
      const index = await ensureIndex(parsed.values.workspace ?? process.cwd(), parsed.values["cache-dir"], io.stderr);
      io.stdout(formatSkeleton(skeleton(index, file)));
      return EXIT_OK;
    }
    case "warp": {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          direction: { type: "string" },
          depth: { type: "string" },
          workspace: { type: "string" },
          "cache-dir": { type: "string" },
        },
      });
      const symbol = requirePositional(parsed.positionals, "symbol", "callers");
      const index = await ensureIndex(parsed.values.workspace ?? process.cwd(), parsed.values["cache-dir"], io.stderr);
      const depthValue = numericOption(parsed.values.depth, "depth", 1);
      const direction = parsed.values.direction;
      if (direction !== undefined && direction !== "in" && direction !== "out") {
        throw new Error(`osnova warp: --direction must be "in" or "out", got ${JSON.stringify(direction)}`);
      }
      const result = callersDetailed(index, symbol, {
        ...(direction !== undefined ? { direction } : {}),
        ...(depthValue !== undefined ? { depth: depthValue } : {}),
      });
      io.stdout(formatCallersDetailed(result));
      return EXIT_OK;
    }
    case "groundwork": {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          "max-dirs": { type: "string" },
          workspace: { type: "string" },
          "cache-dir": { type: "string" },
        },
      });
      const index = await ensureIndex(parsed.values.workspace ?? process.cwd(), parsed.values["cache-dir"], io.stderr);
      const maxDirsValue = numericOption(parsed.values["max-dirs"], "max-dirs", 1);
      io.stdout(
        formatMap(
          map(index, {
            maxDirs: maxDirsValue,
          }),
        ),
      );
      return EXIT_OK;
    }
    case "footing": {
      const parsed = parseArgs({ args: rest, allowPositionals: true, options: {
        task: { type: "string", default: "understand" }, symbol: { type: "string", multiple: true }, in: { type: "string" },
        limit: { type: "string", short: "n" }, depth: { type: "string" }, "max-code-units": { type: "string" },
        workspace: { type: "string" }, "cache-dir": { type: "string" },
      } });
      const task = parsed.values.task;
      if (task !== "understand" && task !== "change" && task !== "review") throw new Error("osnova: invalid context task");
      const budget = numericOption(parsed.values["max-code-units"], "max-code-units", 1) ?? maximumTextResponseCodeUnits;
      if (budget > maximumTextResponseCodeUnits) throw new RangeError(`osnova: CLI context budget cannot exceed ${maximumTextResponseCodeUnits}`);
      const index = await ensureIndex(parsed.values.workspace ?? process.cwd(), parsed.values["cache-dir"], io.stderr);
      const result = taskContext(index, { task, question: parsed.positionals.join(" "), symbols: parsed.values.symbol,
        in: parsed.values.in, limit: numericOption(parsed.values.limit, "limit"),
        maxDepth: numericOption(parsed.values.depth, "depth", 1), maxCodeUnits: budget });
      io.stdout(jsonOutput(result, "footing"));
      return EXIT_OK;
    }
    case "settle": {
      const parsed = parseArgs({ args: rest, options: { "base-cache": { type: "string" }, depth: { type: "string" }, workspace: { type: "string" }, "cache-dir": { type: "string" } } });
      const baseCache = parsed.values["base-cache"];
      if (baseCache === undefined) throw new Error("osnova settle: --base-cache is required");
      const root = path.resolve(parsed.values.workspace ?? process.cwd());
      const cacheDir = resolveCacheDir(parsed.values["cache-dir"]);
      const baseReal = await fs.realpath(baseCache).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new Error(`osnova settle: baseline cache does not exist: ${baseCache}`);
        throw error;
      });
      const currentReal = await fs.realpath(cacheDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return path.resolve(cacheDir);
      });
      if (baseReal === currentReal) throw new Error("osnova settle: base and current caches must be distinct");
      const base = await loadArtifact(root, baseCache);
      if (base === undefined) throw new Error("osnova settle: baseline index is missing or incompatible");
      const current = await ensureIndex(root, cacheDir, io.stderr);
      const result = impact(base, current, { maxDepth: numericOption(parsed.values.depth, "depth", 1) });
      io.stdout([
        `base ${result.base.generation}\ncurrent ${result.current.generation}`,
        `${result.changes.length} symbol changes; ${result.dependents.length} dependents; ${result.omitted.dependentFrontier} frontier items omitted`,
        ...result.changes.map((change) => `${change.kind}: ${change.before?.symbol.qualifiedName ?? "<new>"} -> ${change.after?.symbol.qualifiedName ?? "<deleted>"}`),
        ...result.dependents.map((dependent) => `${dependent.snapshot} d${dependent.depth} ${dependent.symbol?.qualifiedName ?? dependent.file} [source ${dependent.receipt.hash}]`),
        `uncertainty: ${result.uncertainty.unresolvedEdges} unresolved edges; ${result.uncertainty.notes.join(", ")}`,
      ].join("\n"));
      return EXIT_OK;
    }
    case "plumb": {
      const parsed = parseArgs({ args: rest, allowPositionals: true, options: {
        site: { type: "string", multiple: true }, "sites-file": { type: "string" }, direction: { type: "string" }, depth: { type: "string" },
        workspace: { type: "string" }, "cache-dir": { type: "string" },
      } });
      const symbol = parsed.positionals.join(" ").trim();
      if (symbol.length === 0) throw new Error("osnova plumb: missing <symbol> argument");
      const direction = parsed.values.direction;
      if (direction !== undefined && direction !== "in" && direction !== "out") throw new Error(`osnova plumb: --direction must be "in" or "out", got ${JSON.stringify(direction)}`);
      const fromFile = parsed.values["sites-file"] === undefined ? [] : (await fs.readFile(parsed.values["sites-file"], "utf8")).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
      const claims = parseClaims([...(parsed.values.site ?? []), ...fromFile]);
      if (claims.length === 0) throw new Error("osnova plumb: give at least one --site path:line or a --sites-file");
      const index = await ensureIndex(parsed.values.workspace ?? process.cwd(), parsed.values["cache-dir"], io.stderr);
      const result = plumb(index, symbol, claims, { direction, depth: numericOption(parsed.values.depth, "depth", 1) });
      io.stdout(boundText(formatPlumb(result, symbol), maximumPlumbCodeUnits));
      return EXIT_OK;
    }
    case "coverage": {
      const parsed = parseArgs({ args: rest, options: { json: { type: "boolean" }, workspace: { type: "string" }, "cache-dir": { type: "string" } } });
      const index = await ensureIndex(parsed.values.workspace ?? process.cwd(), parsed.values["cache-dir"], io.stderr);
      const report = resolutionCoverage(index);
      io.stdout(parsed.values.json === true ? jsonOutput(report, "coverage") : formatCoverage(report));
      return EXIT_OK;
    }
    case "update-check": {
      const parsed = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
      const { updateCheck, formatUpdateCheck } = await import("./update-check.js");
      const result = await updateCheck();
      io.stdout(parsed.values.json === true ? jsonOutput(result, "update-check") : formatUpdateCheck(result));
      return result.outdated ? EXIT_STALE : EXIT_OK;
    }
    case "doctor": {
      const parsed = parseArgs({ args: rest, options: { workspace: { type: "string" }, "cache-dir": { type: "string" } } });
      const report = await doctor(parsed.values.workspace ?? process.cwd(), { cacheDir: parsed.values["cache-dir"] });
      io.stdout(jsonOutput(report, "doctor"));
      return report.ok ? EXIT_OK : EXIT_STALE;
    }
    case "setup": {
      const parsed = parseArgs({ args: rest, options: { preview: { type: "boolean" }, apply: { type: "boolean" }, client: { type: "string" }, config: { type: "string" }, command: { type: "string", multiple: true }, home: { type: "string" }, hooks: { type: "boolean" }, nudge: { type: "boolean" }, plugin: { type: "boolean" }, skill: { type: "boolean" }, instructions: { type: "string" } } });
      const mode = parsed.values.apply === true ? "apply" : parsed.values.preview === true ? "preview" : undefined;
      if (mode === undefined) throw new Error("osnova setup requires --preview or --apply");
      const client = parsed.values.client;
      if (client !== undefined && !setupClients.some((candidate) => candidate.id === client)) {
        throw new Error(`osnova setup --client must be one of: ${setupClients.map((candidate) => candidate.id).join(", ")}`);
      }
      if (client === undefined && parsed.values.instructions === undefined && parsed.values.hooks !== true && parsed.values.skill !== true) throw new Error("osnova setup needs --client <id>, --hooks, --plugin, --skill and/or --instructions <file>");
      if (parsed.values.hooks === true && client !== undefined && !hookClients.includes(client as HookClient)) throw new Error(`osnova setup --hooks supports --client ${hookClients.join(", ")}`);
      const command = parsed.values.command !== undefined && parsed.values.command.length > 0 ? parsed.values.command : undefined;
      const { planMcp, planHooks, planPlugin, planSkill, planInstructions, applyChanges, pluginClients } = await import("../diagnostics/setup-apply.js");
      if (parsed.values.skill === true && client !== undefined && client !== "claude-code") throw new Error("osnova setup --skill supports --client claude-code");
      if (parsed.values.plugin === true && (client === undefined || !(pluginClients as readonly string[]).includes(client))) throw new Error(`osnova setup --plugin supports --client ${pluginClients.join(", ")}`);
      const planned = [];
      if (client !== undefined) planned.push(await planMcp(client as SetupClientId, { home: parsed.values.home, configPath: parsed.values.config, command }));
      if (parsed.values.hooks === true) planned.push(await planHooks({ home: parsed.values.home, command, client: (client ?? "claude-code") as HookClient, nudge: parsed.values.nudge === true }));
      if (parsed.values.plugin === true) planned.push(await planPlugin(client as PluginClient, { home: parsed.values.home }));
      if (parsed.values.skill === true) planned.push(await planSkill({ home: parsed.values.home }));
      if (parsed.values.instructions !== undefined) planned.push(await planInstructions(parsed.values.instructions));
      if (mode === "preview") {
        io.stdout(planned.map((change) => [`osnova setup preview: ${change.kind === "mcp" ? client : change.kind}, ${change.action}, ${change.path}`, change.diff.trimEnd(), change.notice].filter((line) => line.length > 0).join("\n")).join("\n\n"));
        return EXIT_OK;
      }
      const applied = await applyChanges(planned);
      io.stdout(applied.map((change) => `osnova setup applied: ${change.kind === "mcp" ? client : change.kind}, ${change.written ? change.action : "unchanged"}, ${change.path}${change.backup === undefined ? "" : ` (backup ${change.backup})`}${change.written && change.notice.length > 0 ? `\n  ${change.notice}` : ""}`).join("\n"));
      return EXIT_OK;
    }
    case "hook": {
      const parsed = parseArgs({ args: rest, allowPositionals: true, options: { workspace: { type: "string" }, "cache-dir": { type: "string" }, command: { type: "string", multiple: true }, client: { type: "string" }, nudge: { type: "boolean" } } });
      const event = parsed.positionals[0];
      const hookClient = parsed.values.client;
      if (hookClient !== undefined && !hookClients.includes(hookClient as HookClient)) throw new Error(`osnova hook --client must be one of: ${hookClients.join(", ")}`);
      if (event !== "prompt" && event !== "session" && event !== "stop" && event !== "tool" && event !== "install-preview") throw new Error("osnova hook needs one of: prompt, session, stop, tool, install-preview");
      const raw = event === "install-preview" ? "" : await (io.stdin ?? readStdin)();
      await runHook(event, raw, io, { client: hookClient as HookClient | undefined, nudge: parsed.values.nudge, workspace: parsed.values.workspace, cacheDir: parsed.values["cache-dir"], command: parsed.values.command !== undefined && parsed.values.command.length > 0 ? parsed.values.command : undefined });
      return EXIT_OK;
    }
    case "mcp": {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { workspace: { type: "string" }, "cache-dir": { type: "string" }, watch: { type: "boolean" } },
      });
      const workspace = parsed.values.workspace ?? workspaceRootFor(process.cwd());
      const { runMcpStdio } = await import("../mcp/server.js");
      await runMcpStdio(path.resolve(workspace), {
        ...(parsed.values["cache-dir"] !== undefined ? { cacheDir: parsed.values["cache-dir"] } : {}),
        ...(parsed.values.watch === true ? { watch: true } : {}),
      });
      return EXIT_OK;
    }
    default:
      io.stderr(`osnova: unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
      return EXIT_ERROR;
  }
}

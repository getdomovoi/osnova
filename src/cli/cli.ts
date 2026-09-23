import path from "node:path";
import { promises as fs, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildIndex } from "../index/build.js";
import { hookClients, hookEvents, runHook, workspaceRootFor } from "./hook.js";
import type { HookClient, HookEvent } from "./hook.js";
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
import { formatAsk, leanAskBody, formatCallersDetailed, formatCallersDetailedBounded, formatCoverage, formatFindTextResult, formatImpactDependent, formatImpactFiles, formatImpactUncertainty, formatPlumb, formatIndexDiagnostics, formatMap, formatSkeleton, formatSymbolsUnderTest, formatTestsFor, formatUnreferenced } from "../query/format.js";
import { resolutionCoverage } from "../query/coverage.js";
import { plumb, parseClaims } from "../query/plumb.js";
import { symbolsUnderTest, testsFor } from "../query/tests.js";
import { unreferenced } from "../query/unreferenced.js";
import type { OsnovaIndex, SymbolKind } from "../types.js";
import { boundText, maximumPlumbCodeUnits } from "../query/budget.js";
import { scopedAsk } from "../query/scoped.js";
import { impact } from "../query/impact.js";
import { baseDiff, materializeBaseRef } from "../index/base-ref.js";
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
  osnova ground "<question>" [--in <path>] [-n <n>] [--full] [--lean] [--scoped] [--workspace <path>] [--cache-dir <path>]
  osnova thread "<pattern>" [--fixed] [-i] [--in <path>] [-n <n>] [--workspace <path>] [--cache-dir <path>]
  osnova outline <file> [--workspace <path>] [--cache-dir <path>]
  osnova warp <symbol> [--direction in|out] [--depth <n>] [--full] [--workspace <path>] [--cache-dir <path>]
  osnova groundwork [--max-dirs <n>] [--workspace <path>] [--cache-dir <path>]
  osnova footing "<question>" [--task understand|change|review] [--symbol <qualified>] [--in <path>] [--workspace <path>] [--cache-dir <path>]
  osnova settle <--base-ref <ref> | --base-cache <path>> [--depth <n>] [--workspace <path>] [--cache-dir <path>]
  osnova coverage [--json] [--workspace <path>] [--cache-dir <path>]
  osnova plumb <symbol> --site <path:line> [--site ...] [--sites-file <path>] [--direction in|out] [--depth <n>] [--workspace <path>] [--cache-dir <path>]
  osnova tests <symbol...> [--no-import-only] [-n <n>] [--workspace <path>] [--cache-dir <path>]
  osnova tests --file <path> [-n <n>] [--workspace <path>] [--cache-dir <path>]
  osnova unreferenced [--scope <prefix>] [--kinds <a,b>] [--exported] [-n <n>] [--workspace <path>] [--cache-dir <path>]   (candidates, never proof)
  osnova doctor [--workspace <path>] [--cache-dir <path>]
  osnova setup <--preview|--apply> [--client <claude-code|codex|opencode|kilo|cursor|pi>] [--hooks [--nudge] [--gate <on|off>]] [--plugin] [--skill] [--instructions <AGENTS.md>] [--config <path>] [--command <exe>] [--home <path>]
  osnova hook <prompt|session|stop|tool|gate|mark|install-preview> [--client <claude-code|codex|cursor>] [--nudge] [--gate <on|off>] [--full-contract] [--workspace <path>] [--cache-dir <path>] [--command <exe>]   (editor hooks; payload on stdin)
  osnova mcp [--workspace <path>] [--cache-dir <path>] [--watch]   (default workspace: current directory)
  osnova update-check [--json]   (the only command that opens a network connection; asks the npm registry for the latest version)

queries refresh the index first so answers describe current disk state.
without --workspace, a query or symbol positional that names an existing directory (absolute, ., .., or ending with a path separator) exits 2: pass the workspace with --workspace <path>.`;

const EXIT_OK = 0;
const cliSymbolKinds: readonly SymbolKind[] = ["function", "method", "class", "struct", "interface", "trait", "enum", "type", "constant", "module"];
const cliCallersCodeUnits = 2_048;
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

function strayDirectoryPositional(values: readonly string[]): string | undefined {
  for (const value of values) {
    const pathLike = value === "." || value === ".." || path.isAbsolute(value) || value.endsWith("/") || value.endsWith(path.sep);
    if (!pathLike) continue;
    try {
      if (statSync(path.resolve(value)).isDirectory()) return value;
    } catch {
      continue;
    }
  }
  return undefined;
}

function rejectStrayDirectory(values: readonly string[], workspace: string | undefined, command: string, io: CliIo): boolean {
  if (workspace !== undefined) return false;
  const stray = strayDirectoryPositional(values);
  if (stray === undefined) return false;
  io.stderr(`osnova ${command}: ${JSON.stringify(stray)} looks like a directory; pass the workspace with --workspace <path>`);
  return true;
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

function gateFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "on") return true;
  if (value === "off") return false;
  throw new Error("osnova: --gate must be on or off");
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
      const index = await buildIndex(root, { cacheDir, onProgress: (event) => {
        if (event.phase === "seed") io.stdout(`seeded from sibling worktree cache ${event.sibling ?? ""}: ${event.done} of ${event.total} files reused`);
        const skipped = event.skippedSymlinkedDirectories;
        if (skipped !== undefined && skipped.length > 0) {
          io.stderr(`osnova build: skipped ${skipped.length} symlinked director${skipped.length === 1 ? "y" : "ies"}; symlinks are not followed: ${skipped.join(", ")}`);
        }
      } });
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
          lean: { type: "boolean" },
          scoped: { type: "boolean" },
          workspace: { type: "string" },
          "cache-dir": { type: "string" },
        },
      });
      const question = parsed.positionals.join(" ").trim();
      if (question.length === 0) throw new Error("osnova ground: missing <question> argument");
      if (rejectStrayDirectory(parsed.positionals, parsed.values.workspace, "ground", io)) return EXIT_ERROR;
      const index = await ensureIndex(parsed.values.workspace ?? process.cwd(), parsed.values["cache-dir"], io.stderr);
      const limitValue = numericOption(parsed.values.limit, "limit");
      const lean = parsed.values.lean === true;
      if (parsed.values.scoped === true) {
        const result = scopedAsk(index, question, { in: parsed.values.in, limit: limitValue, full: lean ? false : parsed.values.full });
        io.stdout(`osnova generation ${result.receipt.generation}; ${result.scopes.length} scopes; ${result.omittedHits} hits omitted\n` +
          result.hits.map((hit) => {
            const where = `[${hit.scope || "."}] ${hit.file}:${hit.line}`;
            if (!lean) return `${where} ${hit.symbol?.qualifiedName ?? "<file>"}\n${hit.excerpt}`;
            return `${where}${hit.symbol === null ? "" : ` ${hit.symbol.kind} ${hit.symbol.qualifiedName}`}${leanAskBody(hit)}`;
          }).join("\n\n"));
        return EXIT_OK;
      }
      const result = ask(index, question, {
        in: parsed.values.in,
        limit: limitValue,
        full: lean ? false : parsed.values.full,
      });
      io.stdout(formatAsk(result, { lean }));
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
          full: { type: "boolean" },
          workspace: { type: "string" },
          "cache-dir": { type: "string" },
        },
      });
      const symbol = requirePositional(parsed.positionals, "symbol", "callers");
      if (rejectStrayDirectory(parsed.positionals, parsed.values.workspace, "warp", io)) return EXIT_ERROR;
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
      io.stdout(parsed.values.full === true ? formatCallersDetailed(result) : formatCallersDetailedBounded(result, cliCallersCodeUnits));
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
      if (rejectStrayDirectory(parsed.positionals, parsed.values.workspace, "footing", io)) return EXIT_ERROR;
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
      const parsed = parseArgs({ args: rest, options: { "base-ref": { type: "string" }, "base-cache": { type: "string" }, depth: { type: "string" }, workspace: { type: "string" }, "cache-dir": { type: "string" } } });
      const baseCache = parsed.values["base-cache"];
      const baseRef = parsed.values["base-ref"];
      if (baseCache !== undefined && baseRef !== undefined) throw new Error("osnova settle: use either --base-ref or --base-cache");
      if (baseCache === undefined && baseRef === undefined) throw new Error("osnova settle: --base-ref or --base-cache is required");
      const root = path.resolve(parsed.values.workspace ?? process.cwd());
      const cacheDir = resolveCacheDir(parsed.values["cache-dir"]);
      const maxDepth = numericOption(parsed.values.depth, "depth", 1) ?? 1;
      let result;
      if (baseRef !== undefined) {
        const base = await materializeBaseRef(root, baseRef, { cacheDir });
        io.stderr(`osnova settle: base ${baseRef} = ${base.sha} ${base.reused ? "reused" : "built"} at ${base.dir}`);
        const diff = await baseDiff(root, base.sha);
        const current = await ensureIndex(root, cacheDir, io.stderr);
        result = impact(base.index, current, { diff: diff.trim().length === 0 ? undefined : diff, maxDepth });
      } else {
        const baseReal = await fs.realpath(baseCache!).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") throw new Error(`osnova settle: baseline cache does not exist: ${baseCache}`);
          throw error;
        });
        const currentReal = await fs.realpath(cacheDir).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return path.resolve(cacheDir);
        });
        if (baseReal === currentReal) throw new Error("osnova settle: base and current caches must be distinct");
        const base = await loadArtifact(root, baseCache!);
        if (base === undefined) throw new Error("osnova settle: baseline index is missing or incompatible");
        const current = await ensureIndex(root, cacheDir, io.stderr);
        result = impact(base, current, { maxDepth });
      }
      io.stdout([
        `base ${result.base.generation}\ncurrent ${result.current.generation}`,
        `${result.changes.length} symbol changes; ${result.dependents.length} dependents; ${result.omitted.dependentFrontier} frontier items omitted`,
        ...result.changes.map((change) => `${change.kind}: ${change.before?.symbol.qualifiedName ?? "<new>"} -> ${change.after?.symbol.qualifiedName ?? "<deleted>"}`),
        ...formatImpactFiles(result),
        ...result.dependents.map(formatImpactDependent),
        formatImpactUncertainty(result.uncertainty),
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
      if (rejectStrayDirectory(parsed.positionals, parsed.values.workspace, "plumb", io)) return EXIT_ERROR;
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
    case "tests": {
      const parsed = parseArgs({ args: rest, allowPositionals: true, options: {
        file: { type: "string" }, "no-import-only": { type: "boolean" }, limit: { type: "string", short: "n" }, workspace: { type: "string" }, "cache-dir": { type: "string" },
      } });
      const symbols = parsed.positionals.filter((name) => name.length > 0);
      if (rejectStrayDirectory(parsed.positionals, parsed.values.workspace, "tests", io)) return EXIT_ERROR;
      const file = parsed.values.file;
      if ((symbols.length === 0) === (file === undefined)) throw new Error("osnova tests: give either <symbol...> or --file <path>, not both");
      const limit = numericOption(parsed.values.limit, "limit");
      const includeImportOnly = parsed.values["no-import-only"] !== true;
      const index = await ensureIndex(parsed.values.workspace ?? process.cwd(), parsed.values["cache-dir"], io.stderr);
      io.stdout(file === undefined ? formatTestsFor(testsFor(index, symbols, { limit, includeImportOnly })) : formatSymbolsUnderTest(symbolsUnderTest(index, file, { limit })));
      return EXIT_OK;
    }
    case "unreferenced": {
      const parsed = parseArgs({ args: rest, options: {
        scope: { type: "string" }, kinds: { type: "string" }, exported: { type: "boolean" }, limit: { type: "string", short: "n" },
        workspace: { type: "string" }, "cache-dir": { type: "string" },
      } });
      const kinds = parsed.values.kinds === undefined ? undefined : parsed.values.kinds.split(",").map((kind) => kind.trim()).filter((kind) => kind.length > 0);
      for (const kind of kinds ?? []) {
        if (!(cliSymbolKinds as readonly string[]).includes(kind)) throw new Error(`osnova unreferenced: --kinds must be symbol kinds (${cliSymbolKinds.join(", ")}), got ${JSON.stringify(kind)}`);
      }
      const index = await ensureIndex(parsed.values.workspace ?? process.cwd(), parsed.values["cache-dir"], io.stderr);
      const result = unreferenced(index, {
        scope: parsed.values.scope, kinds: kinds as readonly SymbolKind[] | undefined, limit: numericOption(parsed.values.limit, "limit"), includeExported: parsed.values.exported,
      });
      io.stdout(formatUnreferenced(result));
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
      const parsed = parseArgs({ args: rest, options: { preview: { type: "boolean" }, apply: { type: "boolean" }, client: { type: "string" }, config: { type: "string" }, command: { type: "string", multiple: true }, home: { type: "string" }, hooks: { type: "boolean" }, nudge: { type: "boolean" }, gate: { type: "string" }, plugin: { type: "boolean" }, skill: { type: "boolean" }, instructions: { type: "string" } } });
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
      if (parsed.values.hooks === true) planned.push(await planHooks({ home: parsed.values.home, command, client: (client ?? "claude-code") as HookClient, nudge: parsed.values.nudge === true, gate: gateFlag(parsed.values.gate) }));
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
      const parsed = parseArgs({ args: rest, allowPositionals: true, options: { workspace: { type: "string" }, "cache-dir": { type: "string" }, command: { type: "string", multiple: true }, client: { type: "string" }, nudge: { type: "boolean" }, gate: { type: "string" }, "full-contract": { type: "boolean" } } });
      const event = parsed.positionals[0];
      const hookClient = parsed.values.client;
      if (hookClient !== undefined && !hookClients.includes(hookClient as HookClient)) throw new Error(`osnova hook --client must be one of: ${hookClients.join(", ")}`);
      if (!hookEvents.includes(event as HookEvent)) throw new Error(`osnova hook needs one of: ${hookEvents.join(", ")}`);
      const raw = event === "install-preview" ? "" : await (io.stdin ?? readStdin)();
      await runHook(event as HookEvent, raw, io, { client: hookClient as HookClient | undefined, nudge: parsed.values.nudge, gate: gateFlag(parsed.values.gate), fullContract: parsed.values["full-contract"], workspace: parsed.values.workspace, cacheDir: parsed.values["cache-dir"], command: parsed.values.command !== undefined && parsed.values.command.length > 0 ? parsed.values.command : undefined });
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

import path from "node:path";
import { promises as fs } from "node:fs";
import { parseArgs } from "node:util";
import { buildIndex } from "../index/build.js";
import { refreshWorkspace } from "../api.js";
import { indexHealth } from "../index/health.js";
import { loadArtifact } from "../index/serialize.js";
import { resolveCacheDir } from "../cache/cache.js";
import { ask } from "../query/ask.js";
import { findTextDetailed } from "../query/findText.js";
import { skeleton } from "../query/skeleton.js";
import { callersDetailed } from "../query/callers.js";
import { map } from "../query/map.js";
import { formatAsk, formatCallersDetailed, formatFindTextResult, formatIndexDiagnostics, formatMap, formatSkeleton } from "../query/format.js";
import type { OsnovaIndex } from "../types.js";
import { boundText } from "../query/budget.js";
import { scopedAsk } from "../query/scoped.js";
import { impact } from "../query/impact.js";
import { taskContext } from "../query/task-context.js";
import { maximumTextResponseCodeUnits } from "../types.js";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const USAGE = `osnova: deterministic repository context engine

usage:
  osnova build <root> [--cache-dir <path>]
  osnova check <root> [--cache-dir <path>]
  osnova ask "<question>" [--in <path>] [-n <n>] [--full] [--workspace <path>] [--cache-dir <path>]
  osnova grep "<pattern>" [--fixed] [-i] [--in <path>] [-n <n>] [--workspace <path>] [--cache-dir <path>]
  osnova skeleton <file> [--workspace <path>] [--cache-dir <path>]
  osnova callers <symbol> [--direction in|out] [--depth <n>] [--workspace <path>] [--cache-dir <path>]
  osnova map [--max-dirs <n>] [--workspace <path>] [--cache-dir <path>]
  osnova scoped-ask "<question>" [--in <path>] [-n <n>] [--workspace <path>] [--cache-dir <path>]
  osnova context "<question>" [--task understand|change|review] [--symbol <qualified>] [--in <path>] [--workspace <path>] [--cache-dir <path>]
  osnova impact --base-cache <path> [--depth <n>] [--workspace <path>] [--cache-dir <path>]
  osnova mcp --workspace <path> [--cache-dir <path>]

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

function requirePositional(values: readonly string[], name: string, command: string): string {
  const value = values[0];
  if (value === undefined || value.length === 0) {
    throw new Error(`osnova ${command}: missing <${name}> argument`);
  }
  return value;
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = { stdout: (t) => process.stdout.write(t + "\n"), stderr: (t) => process.stderr.write(t + "\n") },
): Promise<number> {
  const rawIo = io;
  io = {
    stdout: (text) => rawIo.stdout(boundText(text)),
    stderr: (text) => rawIo.stderr(boundText(text)),
  };
  const [command = "", ...rest] = argv;
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
    case "ask":
    case "scoped-ask": {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          in: { type: "string" },
          limit: { type: "string", short: "n" },
          full: { type: "boolean" },
          workspace: { type: "string" },
          "cache-dir": { type: "string" },
        },
      });
      const question = parsed.positionals.join(" ").trim();
      if (question.length === 0) throw new Error("osnova ask: missing <question> argument");
      const index = await ensureIndex(parsed.values.workspace ?? process.cwd(), parsed.values["cache-dir"], io.stderr);
      const limitValue = parsed.values.limit !== undefined ? Number(parsed.values.limit) : undefined;
      if (command === "scoped-ask") {
        const result = scopedAsk(index, question, { in: parsed.values.in, limit: limitValue, full: parsed.values.full });
        io.stdout(`generation ${result.receipt.generation}; ${result.scopes.length} scopes; ${result.omittedHits} hits omitted\n` +
          result.hits.map((hit) => `[${hit.scope || "."}] ${hit.file}:${hit.line} ${hit.symbol?.qualifiedName ?? "<file>"}\n${hit.excerpt}`).join("\n\n"));
        return EXIT_OK;
      }
      const result = ask(index, question, {
        in: parsed.values.in,
        limit: limitValue !== undefined && Number.isFinite(limitValue) ? limitValue : undefined,
        full: parsed.values.full,
      });
      io.stdout(formatAsk(result));
      return EXIT_OK;
    }
    case "grep": {
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
      const limitValue = parsed.values.limit !== undefined ? Number(parsed.values.limit) : undefined;
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
    case "skeleton": {
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
    case "callers": {
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
      const depthValue = parsed.values.depth !== undefined ? Number(parsed.values.depth) : undefined;
      const direction = parsed.values.direction;
      if (direction !== undefined && direction !== "in" && direction !== "out") {
        throw new Error(`osnova callers: --direction must be "in" or "out", got ${JSON.stringify(direction)}`);
      }
      const result = callersDetailed(index, symbol, {
        ...(direction !== undefined ? { direction } : {}),
        ...(depthValue !== undefined ? { depth: depthValue } : {}),
      });
      io.stdout(formatCallersDetailed(result));
      return EXIT_OK;
    }
    case "map": {
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
      const maxDirsValue = parsed.values["max-dirs"] !== undefined ? Number(parsed.values["max-dirs"]) : undefined;
      io.stdout(
        formatMap(
          map(index, {
            maxDirs: maxDirsValue !== undefined && Number.isFinite(maxDirsValue) ? maxDirsValue : undefined,
          }),
        ),
      );
      return EXIT_OK;
    }
    case "context": {
      const parsed = parseArgs({ args: rest, allowPositionals: true, options: {
        task: { type: "string", default: "understand" }, symbol: { type: "string", multiple: true }, in: { type: "string" },
        limit: { type: "string", short: "n" }, depth: { type: "string" }, "max-code-units": { type: "string" },
        workspace: { type: "string" }, "cache-dir": { type: "string" },
      } });
      const task = parsed.values.task;
      if (task !== "understand" && task !== "change" && task !== "review") throw new Error("osnova: invalid context task");
      const budget = parsed.values["max-code-units"] === undefined ? maximumTextResponseCodeUnits : Number(parsed.values["max-code-units"]);
      if (budget > maximumTextResponseCodeUnits) throw new RangeError(`osnova: CLI context budget cannot exceed ${maximumTextResponseCodeUnits}`);
      const index = await ensureIndex(parsed.values.workspace ?? process.cwd(), parsed.values["cache-dir"], io.stderr);
      const result = taskContext(index, { task, question: parsed.positionals.join(" "), symbols: parsed.values.symbol,
        in: parsed.values.in, limit: parsed.values.limit === undefined ? undefined : Number(parsed.values.limit),
        maxDepth: parsed.values.depth === undefined ? undefined : Number(parsed.values.depth), maxCodeUnits: budget });
      io.stdout(JSON.stringify(result));
      return EXIT_OK;
    }
    case "impact": {
      const parsed = parseArgs({ args: rest, options: { "base-cache": { type: "string" }, depth: { type: "string" }, workspace: { type: "string" }, "cache-dir": { type: "string" } } });
      const baseCache = parsed.values["base-cache"];
      if (baseCache === undefined) throw new Error("osnova impact: --base-cache is required");
      const root = path.resolve(parsed.values.workspace ?? process.cwd());
      const cacheDir = resolveCacheDir(parsed.values["cache-dir"]);
      const baseReal = await fs.realpath(baseCache);
      const currentReal = await fs.realpath(cacheDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return path.resolve(cacheDir);
      });
      if (baseReal === currentReal) throw new Error("osnova impact: base and current caches must be distinct");
      const base = await loadArtifact(root, baseCache);
      if (base === undefined) throw new Error("osnova impact: baseline index is missing or incompatible");
      const current = await ensureIndex(root, cacheDir, io.stderr);
      const result = impact(base, current, { maxDepth: parsed.values.depth === undefined ? undefined : Number(parsed.values.depth) });
      io.stdout([
        `base ${result.base.generation}\ncurrent ${result.current.generation}`,
        `${result.changes.length} symbol changes; ${result.dependents.length} dependents; ${result.omitted.dependentFrontier} frontier items omitted`,
        ...result.changes.map((change) => `${change.kind}: ${change.before?.symbol.qualifiedName ?? "<new>"} -> ${change.after?.symbol.qualifiedName ?? "<deleted>"}`),
        ...result.dependents.map((dependent) => `${dependent.snapshot} d${dependent.depth} ${dependent.symbol?.qualifiedName ?? dependent.file} [source ${dependent.receipt.hash}]`),
        `uncertainty: ${result.uncertainty.unresolvedEdges} unresolved edges; ${result.uncertainty.notes.join(", ")}`,
      ].join("\n"));
      return EXIT_OK;
    }
    case "mcp": {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { workspace: { type: "string" }, "cache-dir": { type: "string" } },
      });
      const workspace = parsed.values.workspace ?? process.cwd();
      const { runMcpStdio } = await import("../mcp/server.js");
      await runMcpStdio(path.resolve(workspace), {
        ...(parsed.values["cache-dir"] !== undefined ? { cacheDir: parsed.values["cache-dir"] } : {}),
      });
      return EXIT_OK;
    }
    default:
      io.stderr(`osnova: unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
      return EXIT_ERROR;
  }
}

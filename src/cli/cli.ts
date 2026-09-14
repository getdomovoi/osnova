import path from "node:path";
import { parseArgs } from "node:util";
import { buildIndex } from "../index/build.js";
import { applyChanges, freshness } from "../index/incremental.js";
import { loadArtifact, saveArtifact } from "../index/serialize.js";
import { resolveCacheDir } from "../cache/cache.js";
import { ask } from "../query/ask.js";
import { findText } from "../query/findText.js";
import { skeleton } from "../query/skeleton.js";
import { callers } from "../query/callers.js";
import { map } from "../query/map.js";
import { formatAsk, formatCallers, formatFindText, formatMap, formatSkeleton } from "../query/format.js";
import type { OsnovaIndex } from "../types.js";

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
  osnova mcp --workspace <path> [--cache-dir <path>]

queries refresh the index first so answers describe current disk state.`;

const EXIT_OK = 0;
const EXIT_STALE = 1;
const EXIT_ERROR = 2;

async function ensureIndex(
  workspace: string,
  cacheDir?: string,
): Promise<OsnovaIndex> {
  const resolvedCache = resolveCacheDir(cacheDir);
  const absRoot = path.resolve(workspace);
  const loaded = await loadArtifact(absRoot, resolvedCache);
  if (loaded === undefined) {
    return buildIndex(absRoot, { cacheDir: resolvedCache });
  }
  const report = await freshness(loaded, absRoot);
  const stale = [...report.added, ...report.changed, ...report.deleted];
  if (stale.length === 0) return loaded;
  const updated = await applyChanges(loaded, absRoot, stale);
  await saveArtifact(updated, resolvedCache);
  return updated;
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
      const report = await freshness(loaded, absRoot);
      const stale = [...report.added, ...report.changed, ...report.deleted];
      if (stale.length === 0) {
        io.stdout("fresh");
        return EXIT_OK;
      }
      io.stderr(`stale: ${stale.length} file(s): ${stale.join(", ")}`);
      return EXIT_STALE;
    }
    case "ask": {
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
      const index = await ensureIndex(parsed.values.workspace ?? process.cwd(), parsed.values["cache-dir"]);
      const limitValue = parsed.values.limit !== undefined ? Number(parsed.values.limit) : undefined;
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
      const index = await ensureIndex(parsed.values.workspace ?? process.cwd(), parsed.values["cache-dir"]);
      const limitValue = parsed.values.limit !== undefined ? Number(parsed.values.limit) : undefined;
      const groups = findText(index, pattern, {
        fixed: parsed.values.fixed,
        ignoreCase: parsed.values["ignore-case"],
        in: parsed.values.in,
        limit: limitValue !== undefined && Number.isFinite(limitValue) ? limitValue : undefined,
      });
      io.stdout(formatFindText(groups));
      return EXIT_OK;
    }
    case "skeleton": {
      const parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { workspace: { type: "string" }, "cache-dir": { type: "string" } },
      });
      const file = requirePositional(parsed.positionals, "file", "skeleton");
      const index = await ensureIndex(parsed.values.workspace ?? process.cwd(), parsed.values["cache-dir"]);
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
      const index = await ensureIndex(parsed.values.workspace ?? process.cwd(), parsed.values["cache-dir"]);
      const depthValue = parsed.values.depth !== undefined ? Number(parsed.values.depth) : undefined;
      const direction = parsed.values.direction;
      if (direction !== undefined && direction !== "in" && direction !== "out") {
        throw new Error(`osnova callers: --direction must be "in" or "out", got ${JSON.stringify(direction)}`);
      }
      const result = callers(index, symbol, {
        ...(direction !== undefined ? { direction } : {}),
        ...(depthValue !== undefined && Number.isFinite(depthValue) ? { depth: depthValue } : {}),
      });
      io.stdout(formatCallers(result));
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
      const index = await ensureIndex(parsed.values.workspace ?? process.cwd(), parsed.values["cache-dir"]);
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

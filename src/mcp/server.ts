import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { watch as fsWatch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { refreshWorkspace, indexGeneration } from "../api.js";
import { DEFAULT_SKIP_DIRS } from "../index/scan.js";
import { resolveCacheDir } from "../cache/cache.js";
import { ask } from "../query/ask.js";
import { findTextDetailed } from "../query/findText.js";
import { skeleton } from "../query/skeleton.js";
import { callersDetailed } from "../query/callers.js";
import { renderMapCard } from "../query/mapCard.js";
import { taskContext } from "../query/task-context.js";
import { impact } from "../query/impact.js";
import { plumb, parseClaims } from "../query/plumb.js";
import { formatAsk, formatCallersDetailedBounded, formatFindTextResult, formatImpact, formatIndexHealthSummary, formatPlumb, formatSkeletonBounded, formatTaskContext } from "../query/format.js";
import { maximumOsnovaMapCardCodeUnits, maximumTextResponseCodeUnits, type OsnovaIndex } from "../types.js";
import { boundText, maximumPlumbCodeUnits } from "../query/budget.js";
import { OSNOVA_VERSION } from "../version.js";

const maximumMcpSkeletonCodeUnits = 4_096;
const maximumMcpCallersCodeUnits = 4_096;
const maximumMcpMapCodeUnits = 2_048;
const maximumMcpFootingCodeUnits = 4_096;
const maximumMcpSettleCodeUnits = 4_096;
const maximumMcpPlumbCodeUnits = maximumPlumbCodeUnits;
const mcpFootingExcerptLines = 8;
const mcpInlineShortDefinitions = 40;
const mcpGenerationDigits = 16;

const toolDefinitions = [
  {
    name: "osnova_ground",
    description:
      "Search: find definitions by keyword or identifier. Each hit gives exact file:line and inlines the whole definition when it is 40 lines or shorter, so you do not need to read that file again; longer definitions show an 8-line excerpt (full=true inlines them). Start here when you do not know where code lives.",
    inputSchema: {
      type: "object" as const,
      properties: {
        question: { type: "string", description: "Natural-language or keyword query" },
        in: { type: "string", description: "Restrict to a file or directory path (repo-relative)" },
        limit: { type: "number", description: "Maximum hits (default 8)" },
        full: { type: "boolean", description: "Inline whole definitions instead of 8-line excerpts" },
      },
      required: ["question"],
    },
  },
  {
    name: "osnova_thread",
    description:
      "Text search: regex or literal matches over indexed text, grouped by the enclosing definition and ranked by how much else depends on it. Shows up to 10 matches per group and 50 groups by default (limit raises the group cap); totals and omission counts are exact, so you know what was left out.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Regex pattern (or literal text with fixed=true)" },
        fixed: { type: "boolean", description: "Treat pattern as literal text" },
        ignoreCase: { type: "boolean", description: "Case-insensitive matching" },
        in: { type: "string", description: "Restrict to a file or directory path (repo-relative)" },
        limit: { type: "number", description: "Maximum groups (default 50)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "osnova_outline",
    description: "Outline: the definitions of one file with signature and line span, selected by connectivity to fit 4096 code units, with an exact count of any omitted. Use instead of reading a whole file to learn its shape; read only the span you need afterwards.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file: { type: "string", description: "Repo-relative file path" },
      },
      required: ["file"],
    },
  },
  {
    name: "osnova_warp",
    description:
      "Call graph: who calls a symbol (direction=in, default) or what it calls (direction=out), with exact call-site file:line. Accepts file#Class.method, Class.method or a bare name. Use before changing a signature or deleting code. An empty list means no indexed caller, not proof that none exists.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string", description: "Symbol name or qualified name (file#Class.method)" },
        direction: { type: "string", enum: ["in", "out"], description: "in = callers (default), out = callees" },
        depth: { type: "number", description: "Depth the claimed list was made at (default 1); pass 2 when the claim covers callers of callers" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "osnova_groundwork",
    description:
      "Repository map: directory clusters, hubs and hotspots in under 2048 code units. Use once when the repository is unfamiliar; do not follow it with an outline of every directory.",
    inputSchema: {
      type: "object" as const,
      properties: {
        maxDirs: { type: "number", description: "Maximum directory clusters (default 8)" },
      },
    },
  },
  {
    name: "osnova_footing",
    description:
      "Task context: for one task, the seed definitions (inlined when 40 lines or shorter), the callers and callees that connect them, and the test files that touch them, under 4096 code units with exact omission counts. Use once at the start of a change or review that spans more than one file; for a single known symbol use ground or warp instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        question: { type: "string", description: "Natural-language or keyword query used to pick seed symbols (ignored when symbols is given)" },
        symbols: { type: "array", items: { type: "string" }, description: "Seed qualified names (file#Class.method) instead of a question" },
        task: { type: "string", enum: ["understand", "change", "review"], description: "Task shape (default understand)" },
        in: { type: "string", description: "Restrict to a file or directory path (repo-relative)" },
        limit: { type: "number", description: "Maximum retrieval seeds (default 8)" },
        depth: { type: "number", description: "Relationship walk depth (default 3)" },
      },
    },
  },
  {
    name: "osnova_settle",
    description:
      "Change impact: given the output of git diff, the symbols the diff touches and their indexed dependents to the requested depth (default 1), under 4096 code units with exact omission counts. Use once after editing, before declaring done, to find callers the tests do not cover. Compares against the current index only, so deleted symbols are not visible.",
    inputSchema: {
      type: "object" as const,
      properties: {
        diff: { type: "string", description: "Unified diff text with a/ b/ or plain repo-relative paths" },
        depth: { type: "number", description: "Dependent walk depth (default 1)" },
      },
      required: ["diff"],
    },
  },
  {
    name: "osnova_plumb",
    description:
      "Check claims: given a symbol and a list of path:line call sites an agent believes depend on it, says which are confirmed by the index, which are name matches only, which have no call, and which indexed dependents were left out. Use before declaring a caller list complete. Confirmed means an indexed resolved edge, not runtime proof.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string", description: "Symbol name or qualified name (file#Class.method)" },
        sites: { type: "array", items: { type: "string" }, description: "Claimed call sites as repo-relative path:line" },
        direction: { type: "string", enum: ["in", "out"], description: "in = callers of the symbol (default), out = callees" },
        depth: { type: "number", description: "Depth the claimed list was made at (default 1); pass 2 when the claim covers callers of callers" },
      },
      required: ["symbol", "sites"],
    },
  },
] as const;

export interface OsnovaMcpWatchOptions {
  readonly debounceMs?: number;
  readonly maxStaleMs?: number;
}

export interface OsnovaMcpOptions {
  readonly cacheDir?: string;
  readonly watch?: boolean | OsnovaMcpWatchOptions;
}

export interface OsnovaMcpStatus {
  readonly watching: boolean;
  readonly refreshes: number;
  readonly pendingChanges: boolean;
}

export function createOsnovaMcpServer(
  workspace: string,
  options?: OsnovaMcpOptions,
): { server: Server; refresh: () => Promise<OsnovaIndex>; status: () => OsnovaMcpStatus; close: () => void } {
  const cacheDir = resolveCacheDir(options?.cacheDir);
  const absRoot = path.resolve(workspace);
  const watchOptions = options?.watch === true ? {} : options?.watch === false || options?.watch === undefined ? undefined : options.watch;
  const debounceMs = watchOptions?.debounceMs ?? 200;
  const maxStaleMs = watchOptions?.maxStaleMs ?? 30_000;
  let latest: OsnovaIndex | undefined;
  let inFlight: Promise<OsnovaIndex> | undefined;
  let dirty = true;
  let verifiedAt = 0;
  let refreshes = 0;
  // One refresh at a time; a change that arrives during a refresh marks the result stale again.
  function refresh(): Promise<OsnovaIndex> {
    if (inFlight !== undefined) return inFlight;
    dirty = false;
    inFlight = refreshWorkspace(absRoot, { cacheDir, reuseMemory: true }).then((index) => {
      latest = index; verifiedAt = Date.now(); refreshes += 1; return index;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  }
  // With a watcher, a query reuses the last verified index while no change has been seen and the
  // verification is recent; without one, every query verifies the working tree first.
  function current(): Promise<OsnovaIndex> {
    if (watcher !== undefined && latest !== undefined && !dirty && Date.now() - verifiedAt < maxStaleMs) return Promise.resolve(latest);
    return refresh();
  }
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  const cacheInside = path.relative(absRoot, path.resolve(cacheDir));
  const ignoredChange = (file: string | null): boolean => {
    if (file === null) return false;
    const relative = file.split(path.sep).join("/");
    if (cacheInside.length > 0 && !cacheInside.startsWith("..") && relative.startsWith(cacheInside.split(path.sep).join("/"))) return true;
    return relative.split("/").some((segment) => DEFAULT_SKIP_DIRS.has(segment));
  };
  if (watchOptions !== undefined) {
    try {
      watcher = fsWatch(absRoot, { recursive: true, persistent: false }, (_event, file) => {
        if (ignoredChange(file)) return;
        dirty = true;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => { timer = undefined; refresh().catch((error: unknown) => { process.stderr.write(`osnova: watch refresh failed: ${error instanceof Error ? error.message : String(error)}\n`); }); }, debounceMs);
        timer.unref();
      });
      watcher.on("error", (error) => { process.stderr.write(`osnova: watcher stopped: ${error.message}\n`); watcher?.close(); watcher = undefined; });
    } catch (error) {
      process.stderr.write(`osnova: watch unavailable, refreshing per query: ${error instanceof Error ? error.message : String(error)}\n`);
      watcher = undefined;
    }
  }
  const close = (): void => { if (timer !== undefined) clearTimeout(timer); watcher?.close(); watcher = undefined; };
  const status = (): OsnovaMcpStatus => ({ watching: watcher !== undefined, refreshes, pendingChanges: dirty });

  const server = new Server(
    { name: "osnova", version: OSNOVA_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const index = await current();
      const generation = `osnova generation ${indexGeneration(index).slice(0, mcpGenerationDigits)}`;
      const prefix = [generation, formatIndexHealthSummary(index)].filter(Boolean).join("\n");
      switch (name) {
        case "osnova_ground": {
          const question = requireString(args, "question");
          const askOptions = { in: optionalString(args, "in"), limit: optionalNumber(args, "limit"), full: optionalBoolean(args, "full") };
          let text = `${prefix}\n${formatAsk(ask(index, question, { ...askOptions, inlineShortDefinitions: mcpInlineShortDefinitions }))}`;
          if (text.length > maximumTextResponseCodeUnits) text = `${prefix}\n${formatAsk(ask(index, question, askOptions))}`;
          return textResult(text);
        }
        case "osnova_thread": {
          const pattern = requireString(args, "pattern");
          if (args.limit !== undefined && typeof args.limit !== "number") {
            throw new RangeError("osnova: search limits must be nonnegative safe integers");
          }
          const result = findTextDetailed(index, pattern, {
            fixed: optionalBoolean(args, "fixed"),
            ignoreCase: optionalBoolean(args, "ignoreCase"),
            in: optionalString(args, "in"),
            limit: args.limit ?? 50,
            matchesPerGroup: 10,
          });
          return textResult(`${prefix}\n${formatFindTextResult(result)}`);
        }
        case "osnova_outline": {
          const file = requireString(args, "file");
          const available = maximumMcpSkeletonCodeUnits - prefix.length - 1;
          return textResult(`${prefix}\n${formatSkeletonBounded(index, skeleton(index, file), available)}`);
        }
        case "osnova_warp": {
          const symbol = requireString(args, "symbol");
          const direction = optionalString(args, "direction");
          if (direction !== undefined && direction !== "in" && direction !== "out") {
            throw new Error(`direction must be "in" or "out", got ${JSON.stringify(direction)}`);
          }
          if (args.depth !== undefined && typeof args.depth !== "number") {
            throw new RangeError("osnova: caller depth must be a positive safe integer");
          }
          const depthValue = args.depth;
          const result = callersDetailed(index, symbol, {
            ...(direction !== undefined ? { direction } : {}),
            ...(depthValue !== undefined ? { depth: depthValue } : {}),
          });
          const available = maximumMcpCallersCodeUnits - prefix.length - 1;
          return textResult(`${prefix}\n${formatCallersDetailedBounded(result, available)}`);
        }
        case "osnova_groundwork": {
          const card = await renderMapCard(index, {
            maxDirs: optionalNumber(args, "maxDirs") ?? 8,
            staleCount: 0,
            maxCodeUnits: Math.min(maximumOsnovaMapCardCodeUnits, maximumMcpMapCodeUnits) - generation.length - 1,
          });
          return textResult(`${generation}\n${card}`);
        }
        case "osnova_footing": {
          const task = args.task === undefined ? "understand" : args.task;
          if (task !== "understand" && task !== "change" && task !== "review") {
            throw new Error(`task must be "understand", "change" or "review", got ${JSON.stringify(task)}`);
          }
          const symbols = optionalStringArray(args, "symbols");
          const question = optionalString(args, "question");
          if (symbols === undefined && question === undefined) throw new Error("osnova_footing needs a question or a non-empty symbols array");
          for (const key of ["limit", "depth"]) {
            if (args[key] !== undefined && typeof args[key] !== "number") throw new RangeError(`osnova: footing ${key} must be a nonnegative safe integer`);
          }
          const available = maximumMcpFootingCodeUnits - prefix.length - 1;
          const result = taskContext(index, {
            task, question: question ?? "", symbols, in: optionalString(args, "in"),
            limit: optionalNumber(args, "limit"), maxDepth: optionalNumber(args, "depth"), maxCodeUnits: available, excerptLines: mcpFootingExcerptLines, inlineShortDefinitions: mcpInlineShortDefinitions,
            measure: (partial) => formatTaskContext(partial).length,
          });
          return textResult(`${prefix}\n${boundText(formatTaskContext(result), available)}`);
        }
        case "osnova_settle": {
          const diff = requireString(args, "diff");
          if (args.depth !== undefined && typeof args.depth !== "number") {
            throw new RangeError("osnova: settle depth must be a nonnegative safe integer");
          }
          const result = impact(index, index, { diff, maxDepth: optionalNumber(args, "depth") ?? 1 });
          const available = maximumMcpSettleCodeUnits - prefix.length - 1;
          return textResult(`${prefix}\n${boundText(formatImpact(result), available)}`);
        }
        case "osnova_plumb": {
          const symbol = requireString(args, "symbol");
          const sites = optionalStringArray(args, "sites");
          if (sites === undefined) throw new Error("osnova_plumb needs a non-empty sites array of path:line");
          const direction = optionalString(args, "direction");
          if (direction !== undefined && direction !== "in" && direction !== "out") throw new Error(`direction must be "in" or "out", got ${JSON.stringify(direction)}`);
          if (args.depth !== undefined && typeof args.depth !== "number") throw new RangeError("osnova: plumb depth must be a positive safe integer");
          const result = plumb(index, symbol, parseClaims(sites), { direction, depth: optionalNumber(args, "depth") });
          const available = maximumMcpPlumbCodeUnits - prefix.length - 1;
          return textResult(`${prefix}\n${boundText(formatPlumb(result, symbol), available)}`);
        }
        default:
          return errorResult(`unknown tool ${JSON.stringify(name)}`);
      }
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error), toolErrorBudget(name));
    }
  });

  return { server, refresh, status, close };
}

function textResult(text: string, maxCodeUnits?: number): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: boundText(text, maxCodeUnits) }] };
}

function toolErrorBudget(name: string): number | undefined {
  switch (name) {
    case "osnova_outline": return maximumMcpSkeletonCodeUnits;
    case "osnova_warp": return maximumMcpCallersCodeUnits;
    case "osnova_groundwork": return maximumMcpMapCodeUnits;
    case "osnova_footing": return maximumMcpFootingCodeUnits;
    case "osnova_settle": return maximumMcpSettleCodeUnits;
    case "osnova_plumb": return maximumMcpPlumbCodeUnits;
    default: return undefined;
  }
}

function errorResult(message: string, maxCodeUnits?: number): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { ...textResult(`osnova error: ${message}`, maxCodeUnits), isError: true };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required string argument "${key}"`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalStringArray(args: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`argument "${key}" must be a non-empty array of non-empty strings`);
  }
  return value as string[];
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

export async function runMcpStdio(
  workspace: string,
  options?: OsnovaMcpOptions,
): Promise<void> {
  const { server, close } = createOsnovaMcpServer(workspace, options);
  const transport = new StdioServerTransport();
  transport.onclose = close;
  await server.connect(transport);
}

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
import { baseDiff, materializeBaseRef } from "../index/base-ref.js";
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
import { symbolsUnderTest, testsFor } from "../query/tests.js";
import { unreferenced } from "../query/unreferenced.js";
import { formatAsk, formatCallersDetailed, formatCallersDetailedBounded, formatFileDiagnostics, formatFindTextResult, formatImpact, formatIndexHealthSummary, formatPlumb, formatSkeletonBounded, formatSymbolsUnderTest, formatTaskContext, formatTestsFor, formatUnreferenced } from "../query/format.js";
import { maximumOsnovaMapCardCodeUnits, maximumTextResponseCodeUnits, type OsnovaIndex, type SymbolKind } from "../types.js";
import { boundText, maximumPlumbCodeUnits } from "../query/budget.js";
import { OSNOVA_VERSION } from "../version.js";

const symbolKinds = Object.keys({ function: true, method: true, class: true, struct: true, interface: true, trait: true, enum: true, type: true, constant: true, module: true } satisfies Record<SymbolKind, true>) as readonly SymbolKind[];

function isSymbolKind(value: string): value is SymbolKind {
  return (symbolKinds as readonly string[]).includes(value);
}


const maximumMcpSkeletonCodeUnits = 4_096;
// Sent on initialize; clients that honour MCP instructions place it in the system prompt, so every
// harness with an MCP client gets the tool contract without a hook.
export const mcpInstructions = [
  "Osnova is a deterministic call graph of this repository with exact file:line, no type inference, no LLM. Use its tools before grep and file reads.",
  "osnova_footing: task context for a question or named symbols; start here. osnova_ground: ranked symbol and text search, including HTTP routes by verb and path (GET /users). osnova_thread: exhaustive regex search grouped by symbol. osnova_outline: one file's signatures. osnova_warp: callers or callees with the resolution basis of every edge; unresolved edges list same-name candidates. osnova_groundwork: repository map. osnova_settle: dependents of your uncommitted changes (no arguments) before you finish. osnova_plumb: check a claimed list of call sites. osnova_tests: the test files that reference a symbol, or the symbols one test file reaches. osnova_unreferenced: definitions with no indexed caller, as candidates with their unresolved same-name leads, never as proof.",
  "No indexed callers is not proof of absence; an unresolved edge is a lead, not a relationship.",
].join("\n");
const maximumMcpCallersCodeUnits = 2_048;
const maximumMcpMapCodeUnits = 2_048;
const maximumMcpFootingCodeUnits = 4_096;
const maximumMcpSettleCodeUnits = 4_096;
const maximumMcpPlumbCodeUnits = maximumPlumbCodeUnits;
const maximumMcpTestsCodeUnits = 4_096;
const maximumMcpUnreferencedCodeUnits = 4_096;
const mcpFootingExcerptLines = 8;
const mcpInlineShortDefinitions = 40;
const mcpGenerationDigits = 16;

const toolDefinitions = [
  {
    name: "osnova_ground",
    description:
      "Search: find definitions by keyword or identifier. Each hit gives exact file:line and inlines the whole definition when it is 40 lines or shorter, so you do not need to read that file again; longer definitions show an 8-line excerpt (full=true inlines them). Use lean=true when you only need where things are: it keeps file:line, kind, definition span and signature and drops the source lines. Start here when you do not know where code lives. A verb and path (GET /users) finds the route registration and its handler for Express, NestJS, Flask and FastAPI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        question: { type: "string", description: "Natural-language or keyword query" },
        in: { type: "string", description: "Restrict to a file or directory path (repo-relative)" },
        limit: { type: "number", description: "Maximum hits (default 8)" },
        full: { type: "boolean", description: "Inline whole definitions instead of 8-line excerpts" },
        lean: { type: "boolean", description: "Drop the inlined source and keep file:line, kind, definition span and signature; overrides full" },
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
        depth: { type: "number", description: "Hops to walk from the symbol (default 1); 2 also lists callers of callers, or callees of callees with direction=out" },
        full: { type: "boolean", description: "Print every call site with no per-symbol cap or summary (default false); output is still clipped at 16,384 code units" },
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
        kinds: { type: "array", items: { type: "string", enum: [...symbolKinds] }, description: "Only seed question hits of these symbol kinds (default: every kind, real definitions before 1-line constants, type aliases and test-file symbols)" },
      },
    },
  },
  {
    name: "osnova_settle",
    description:
      "Change impact: given the output of git diff, the symbols the diff touches and their indexed dependents to the requested depth (default 1), under 4096 code units with exact omission counts. Use once after editing, before declaring done, to find callers the tests do not cover; with no arguments it checks every uncommitted change against HEAD. A diff alone compares against the current index only, so deleted symbols are not visible; with baseRef (a git commit or ref) it indexes that commit's tree under the cache and compares it with the current index, computing the diff with git when none is given.",
    inputSchema: {
      type: "object" as const,
      properties: {
        diff: { type: "string", description: "Unified diff text with a/ b/ or plain repo-relative paths (omit both diff and baseRef to settle uncommitted changes against HEAD)" },
        baseRef: { type: "string", description: "Git commit or ref to compare against; its tree is indexed under the cache without a checkout" },
        depth: { type: "number", description: "Dependent walk depth (default 1)" },
      },
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
  {
    name: "osnova_tests",
    description:
      "Tests: given symbols, the indexed test files for each one in two separate tiers with separate counts: files with a resolved call or reference edge to the symbol (exact file:line and resolution basis), then files that only import the symbol's file and contain no indexed call or reference to it. An empty resolved tier is stated on its own line; import-only files are leads, not tests of the symbol. Given one test file, the non-test symbols it calls and the files it imports. Exactly one of symbols or file. Use before editing to find the tests to run. No indexed test is not proof of no test, and a listed test is not coverage.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbols: { type: "array", items: { type: "string" }, description: "Symbol names or qualified names (file#Class.method) to find tests for" },
        file: { type: "string", description: "Repo-relative test file whose symbols under test to list" },
        limit: { type: "number", description: "Maximum test files per symbol (default 20) or symbols per file (default 50)" },
        includeImportOnly: { type: "boolean", description: "With symbols: also list test files that only import the symbol's file (default true); false lists only files with a resolved edge" },
      },
    },
  },
  {
    name: "osnova_unreferenced",
    description:
      "Unreferenced candidates: definitions with no resolved call or reference edge from outside their own body in a non-test file, sorted by file and line, each with the count of unresolved same-name call sites (leads that may reach it), test-file sites and identifier mentions in non-test files. Entry points (main, default exports, index.* files, package.json bin files, test files, constructors) are never listed; exported definitions are listed only with includeExported. Candidates only: no indexed caller is not proof of no caller.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: { type: "string", description: "Repo-relative path prefix to examine (default: whole index)" },
        kinds: { type: "array", items: { type: "string", enum: [...symbolKinds] }, description: "Symbol kinds to examine (default function, method, class: the kinds the index records edges to; constants, types and interfaces receive no edges, so asking for them lists nearly all of them)" },
        limit: { type: "number", description: "Maximum candidates (default 50); the omitted count is exact" },
        includeExported: { type: "boolean", description: "Also list exported definitions, which external consumers may reach (default false)" },
      },
    },
  },
] as const;

const argumentNames: ReadonlyMap<string, readonly string[]> = new Map(
  toolDefinitions.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties)]),
);

// The low-level Server validates the JSON-RPC envelope, never a tool's own inputSchema. An agent that
// misspells an argument would otherwise get a confident answer to a question it did not ask.
function checkArguments(name: string, args: unknown): Record<string, unknown> {
  if (args === undefined) return {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error(`arguments for ${name} must be an object`);
  }
  const record = args as Record<string, unknown>;
  const known = argumentNames.get(name);
  if (known === undefined) return record;
  const unknown = Object.keys(record).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    const listed = unknown.map((key) => JSON.stringify(key)).join(", ");
    throw new Error(`unknown argument${unknown.length > 1 ? "s" : ""} ${listed} for ${name}; expected one of ${known.join(", ")}`);
  }
  return record;
}

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
  let changes = 0;
  let verifiedAt = 0;
  let refreshes = 0;
  // One refresh at a time; a change that arrives during a refresh marks the result stale again.
  function refresh(): Promise<OsnovaIndex> {
    if (inFlight !== undefined) return inFlight;
    const seen = changes;
    inFlight = refreshWorkspace(absRoot, { cacheDir, reuseMemory: true }).then((index) => {
      latest = index; verifiedAt = Date.now(); refreshes += 1; if (changes === seen) dirty = false; return index;
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
        changes += 1;
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
    { capabilities: { tools: {} }, instructions: mcpInstructions },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    try {
      const args = checkArguments(name, request.params.arguments);
      const index = await current();
      const generation = `osnova generation ${indexGeneration(index).slice(0, mcpGenerationDigits)}`;
      const prefix = [generation, formatIndexHealthSummary(index)].filter(Boolean).join("\n");
      switch (name) {
        case "osnova_ground": {
          const question = requireString(args, "question");
          const askOptions = { in: optionalString(args, "in"), limit: optionalNumber(args, "limit"), full: optionalBoolean(args, "full") };
          if (optionalBoolean(args, "lean") === true) {
            return textResult(`${prefix}\n${formatAsk(ask(index, question, { ...askOptions, full: false }), { lean: true })}`);
          }
          let text = `${prefix}\n${formatAsk(ask(index, question, { ...askOptions, inlineShortDefinitions: mcpInlineShortDefinitions }))}`;
          if (text.length > maximumTextResponseCodeUnits) text = `${prefix}\n${formatAsk(ask(index, question, askOptions))}`;
          return textResult(text);
        }
        case "osnova_thread": {
          const pattern = requireString(args, "pattern");
          const result = findTextDetailed(index, pattern, {
            fixed: optionalBoolean(args, "fixed"),
            ignoreCase: optionalBoolean(args, "ignoreCase"),
            in: optionalString(args, "in"),
            limit: optionalNumber(args, "limit") ?? 50,
            matchesPerGroup: 10,
          });
          return textResult(`${prefix}\n${formatFindTextResult(result)}`);
        }
        case "osnova_outline": {
          const file = requireString(args, "file");
          const result = skeleton(index, file);
          const head = [prefix, formatFileDiagnostics(index, result.file)].filter(Boolean).join("\n");
          const available = maximumMcpSkeletonCodeUnits - head.length - 1;
          return textResult(`${head}\n${formatSkeletonBounded(index, result, available)}`);
        }
        case "osnova_warp": {
          const symbol = requireString(args, "symbol");
          const direction = optionalString(args, "direction");
          if (direction !== undefined && direction !== "in" && direction !== "out") {
            throw new Error(`direction must be "in" or "out", got ${JSON.stringify(direction)}`);
          }
          const depthValue = optionalNumber(args, "depth");
          const full = optionalBoolean(args, "full") ?? false;
          const result = callersDetailed(index, symbol, {
            ...(direction !== undefined ? { direction } : {}),
            ...(depthValue !== undefined ? { depth: depthValue } : {}),
          });
          if (full) return textResult(boundText(`${prefix}\n${formatCallersDetailed(result)}`, maximumTextResponseCodeUnits));
          const available = maximumMcpCallersCodeUnits - prefix.length - 1;
          return textResult(`${prefix}\n${formatCallersDetailedBounded(result, available)}`);
        }
        case "osnova_groundwork": {
          const card = await renderMapCard(index, {
            maxDirs: optionalNumber(args, "maxDirs"),
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
          const kinds = optionalStringArray(args, "kinds");
          for (const kind of kinds ?? []) {
            if (!isSymbolKind(kind)) throw new Error(`kinds must be symbol kinds (${symbolKinds.join(", ")}), got ${JSON.stringify(kind)}`);
          }
          const available = maximumMcpFootingCodeUnits - prefix.length - 1;
          const result = taskContext(index, {
            task, question: question ?? "", symbols, kinds: kinds?.filter(isSymbolKind), in: optionalString(args, "in"),
            limit: optionalNumber(args, "limit"), maxDepth: optionalNumber(args, "depth"), maxCodeUnits: available, excerptLines: mcpFootingExcerptLines, inlineShortDefinitions: mcpInlineShortDefinitions,
            measure: (partial) => formatTaskContext(partial).length,
          });
          return textResult(`${prefix}\n${boundText(formatTaskContext(result), available)}`);
        }
        case "osnova_settle": {
          const diff = optionalString(args, "diff");
          const explicitRef = optionalString(args, "baseRef");
          // With neither argument the caller means "what did I change": agents made that call on a large share of
          // settle requests and paid a retry each time, so it compares HEAD with the working tree.
          const baseRef = explicitRef ?? (diff === undefined ? "HEAD" : undefined);
          const maxDepth = optionalNumber(args, "depth") ?? 1;
          let result;
          if (baseRef === undefined) result = impact(index, index, { diff, maxDepth });
          else {
            const base = await materializeBaseRef(absRoot, baseRef, { cacheDir }).catch((error: unknown) => {
              if (explicitRef !== undefined) throw error;
              throw new Error(`osnova_settle with no arguments compares against HEAD, which failed here (${error instanceof Error ? error.message : String(error)}); pass diff with a unified diff instead`);
            });
            const computed = diff ?? await baseDiff(absRoot, base.sha);
            result = impact(base.index, index, { diff: computed.trim().length === 0 ? undefined : computed, maxDepth });
          }
          const available = maximumMcpSettleCodeUnits - prefix.length - 1;
          return textResult(`${prefix}\n${boundText(formatImpact(result), available)}`);
        }
        case "osnova_plumb": {
          const symbol = requireString(args, "symbol");
          const sites = optionalStringArray(args, "sites");
          if (sites === undefined) throw new Error("osnova_plumb needs a non-empty sites array of path:line");
          const direction = optionalString(args, "direction");
          if (direction !== undefined && direction !== "in" && direction !== "out") throw new Error(`direction must be "in" or "out", got ${JSON.stringify(direction)}`);
          const result = plumb(index, symbol, parseClaims(sites), { direction, depth: optionalNumber(args, "depth") });
          const available = maximumMcpPlumbCodeUnits - prefix.length - 1;
          return textResult(`${prefix}\n${boundText(formatPlumb(result, symbol), available)}`);
        }
        case "osnova_tests": {
          const symbols = optionalStringArray(args, "symbols");
          const file = optionalString(args, "file");
          if ((symbols === undefined) === (file === undefined)) throw new Error("osnova_tests needs exactly one of a non-empty symbols array or a file");
          const limit = optionalNumber(args, "limit");
          const includeImportOnly = optionalBoolean(args, "includeImportOnly");
          const available = maximumMcpTestsCodeUnits - prefix.length - 1;
          const text = symbols !== undefined ? formatTestsFor(testsFor(index, symbols, { limit, includeImportOnly })) : formatSymbolsUnderTest(symbolsUnderTest(index, file!, { limit }));
          return textResult(`${prefix}\n${boundText(text, available)}`);
        }
        case "osnova_unreferenced": {
          const kinds = optionalStringArray(args, "kinds");
          for (const kind of kinds ?? []) {
            if (!isSymbolKind(kind)) throw new Error(`kinds must be symbol kinds (${symbolKinds.join(", ")}), got ${JSON.stringify(kind)}`);
          }
          const result = unreferenced(index, {
            scope: optionalString(args, "scope"), kinds: kinds?.filter(isSymbolKind), limit: optionalNumber(args, "limit"), includeExported: optionalBoolean(args, "includeExported"),
          });
          const available = maximumMcpUnreferencedCodeUnits - prefix.length - 1;
          return textResult(`${prefix}\n${boundText(formatUnreferenced(result), available)}`);
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
    case "osnova_tests": return maximumMcpTestsCodeUnits;
    case "osnova_unreferenced": return maximumMcpUnreferencedCodeUnits;
    default: return undefined;
  }
}

function errorResult(message: string, maxCodeUnits?: number): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { ...textResult(`osnova error: ${message}`, maxCodeUnits), isError: true };
}

// Readers enforce the declared type and nothing else. Ranges stay with the engine, so the CLI and MCP
// share one message for a value of the right type that is out of range.
const typeName = (value: unknown): string => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (value === undefined) throw new Error(`missing required string argument "${key}"`);
  if (typeof value !== "string") throw new Error(`argument "${key}" must be a string, got ${typeName(value)}`);
  if (value.length === 0) throw new Error(`argument "${key}" must not be empty`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`argument "${key}" must be a string, got ${typeName(value)}`);
  return value.length > 0 ? value : undefined;
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
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error(`argument "${key}" must be a number, got ${typeName(value)}`);
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`argument "${key}" must be a boolean, got ${typeName(value)}`);
  return value;
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

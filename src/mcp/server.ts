import path from "node:path";
import { toolContract } from "../tool-contract.js";
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
export const mcpInstructions = toolContract;
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
      "Search: definitions/routes (GET /users), file:line, source (whole <=40 lines, else excerpt). lean/full select detail.",
    inputSchema: {
      type: "object" as const,
      properties: {
        question: { type: "string", description: "Keywords, name or route" },
        in: { type: "string", description: "Repo-relative scope" },
        limit: { type: "number", description: "Hits; default 8" },
        full: { type: "boolean", description: "Whole definitions" },
        lean: { type: "boolean", description: "Signatures only; overrides full" },
      },
      required: ["question"],
    },
  },
  {
    name: "osnova_thread",
    description:
      "Text search: indexed regex matches grouped by definition; exact omissions. Callers: warp/plumb.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Regex; literal if fixed" },
        fixed: { type: "boolean", description: "Literal pattern" },
        ignoreCase: { type: "boolean", description: "Case insensitive" },
        in: { type: "string", description: "Repo-relative scope" },
        limit: { type: "number", description: "Groups; default 50" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "osnova_outline",
    description: "Outline: file signatures/spans by connectivity, with omission counts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file: { type: "string", description: "Repo-relative file" },
      },
      required: ["file"],
    },
  },
  {
    name: "osnova_warp",
    description:
      "Call graph: callers/callees, including tests; file:line and resolution basis. Verify claims with plumb.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string", description: "Name or file#Class.method" },
        direction: { type: "string", enum: ["in", "out"], description: "in callers (default); out callees" },
        depth: { type: "number", description: "Walk hops; default 1" },
        full: { type: "boolean", description: "All sites; 16,384-unit cap" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "osnova_groundwork",
    description:
      "Repository map: clusters, hubs and hotspots. Start unfamiliar repos here.",
    inputSchema: {
      type: "object" as const,
      properties: {
        maxDirs: { type: "number", description: "Directories; default 8" },
      },
    },
  },
  {
    name: "osnova_footing",
    description:
      "Task context: definitions, edges and test leads. Start cross-file work here; ground/warp for one symbol. Written arguments do not prove runtime values.",
    inputSchema: {
      type: "object" as const,
      properties: {
        question: { type: "string", description: "Seed query; symbols override" },
        symbols: { type: "array", items: { type: "string" }, description: "file#Class.method seeds" },
        task: { type: "string", enum: ["understand", "change", "review"], description: "Shape; default understand" },
        in: { type: "string", description: "Repo-relative scope" },
        limit: { type: "number", description: "Seeds; default 8" },
        depth: { type: "number", description: "Hops; default 3" },
        kinds: { type: "array", items: { type: "string", enum: [...symbolKinds] }, description: "Seed kinds; default all" },
      },
    },
  },
  {
    name: "osnova_settle",
    description:
      "Change impact: after edits use baseRef=HEAD for local changes, including indexed untracked files. Check dependents. Explicit diff for supplied patches; without baseRef deletions are invisible. Missing edges prove nothing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        diff: { type: "string", description: "Unified patch; omit with baseRef" },
        baseRef: { type: "string", description: "Commit/ref; HEAD for local changes" },
        depth: { type: "number", description: "Dependent hops; default 1" },
      },
    },
  },
  {
    name: "osnova_plumb",
    description:
      "Check claims: verify path:line sites, including tests. Reports confirmed, uncertain and missing edges. Indexed is not runtime proof.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string", description: "Name or file#Class.method" },
        sites: { type: "array", items: { type: "string" }, description: "Claimed repo path:line" },
        direction: { type: "string", enum: ["in", "out"], description: "Claimed in callers (default); out callees" },
        depth: { type: "number", description: "Claim hops; default 1" },
      },
      required: ["symbol", "sites"],
    },
  },
  {
    name: "osnova_tests",
    description:
      "Tests: symbol to test files (resolved vs import-only), or test file to symbols. Choose one input. Leads, not coverage.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbols: { type: "array", items: { type: "string" }, description: "Names or file#Class.method" },
        file: { type: "string", description: "Repo-relative test file" },
        limit: { type: "number", description: "Files 20; symbols 50" },
        includeImportOnly: { type: "boolean", description: "Include import-only leads; default true" },
      },
    },
  },
  {
    name: "osnova_unreferenced",
    description:
      "Unreferenced candidates: no resolved non-test callers. Excludes main, exports, index, bin, tests and constructors. Inspect leads before deletion; absence is not proof.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: { type: "string", description: "Repo-relative prefix" },
        kinds: { type: "array", items: { type: "string", enum: [...symbolKinds] }, description: "Kinds; default function/method/class" },
        limit: { type: "number", description: "Candidates; default 50" },
        includeExported: { type: "boolean", description: "Include public exports" },
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
          return textResult(`${prefix}\n${formatFindTextResult(result, index)}`);
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
          const baseRef = optionalString(args, "baseRef");
          const diff = optionalString(args, "diff");
          if (baseRef === undefined && diff === undefined) throw new Error("osnova_settle needs diff or baseRef");
          const maxDepth = optionalNumber(args, "depth") ?? 1;
          let result;
          if (baseRef === undefined) result = impact(index, index, { diff, maxDepth });
          else {
            const base = await materializeBaseRef(absRoot, baseRef, { cacheDir });
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

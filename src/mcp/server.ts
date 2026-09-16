import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { refreshWorkspace, indexGeneration } from "../api.js";
import { resolveCacheDir } from "../cache/cache.js";
import { ask } from "../query/ask.js";
import { findTextDetailed } from "../query/findText.js";
import { skeleton } from "../query/skeleton.js";
import { callersDetailed } from "../query/callers.js";
import { renderMapCard } from "../query/mapCard.js";
import { taskContext } from "../query/task-context.js";
import { impact } from "../query/impact.js";
import { formatAsk, formatCallersDetailedBounded, formatFindTextResult, formatImpact, formatIndexHealthSummary, formatSkeletonBounded, formatTaskContext } from "../query/format.js";
import { maximumOsnovaMapCardCodeUnits, type OsnovaIndex } from "../types.js";
import { boundText } from "../query/budget.js";

const OSNOVA_VERSION = "0.2.0";
const maximumMcpSkeletonCodeUnits = 4_096;
const maximumMcpCallersCodeUnits = 2_048;
const maximumMcpMapCodeUnits = 2_048;
const maximumMcpFootingCodeUnits = 8_192;
const maximumMcpSettleCodeUnits = 4_096;
const mcpFootingExcerptLines = 8;

const canonicalToolDefinitions = [
  {
    name: "osnova_ground",
    description:
      "Search: keyword search over an indexed workspace. Returns ranked hits with exact file:line and a short excerpt of the enclosing definition; full=true inlines the whole definition span. askDetailed provides complete candidate counts through the API.",
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
      "Text search: regex or literal search over indexed text, grouped by enclosing symbol and ranked by incoming-edge count. Shows at most 10 matches per group and 50 groups by default, with totals and explicit omission counts.",
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
    description: "Outline: task-focused signatures and line spans for one indexed file. MCP output is degree-selected under 4096 code units with an exact omission count; the skeleton API returns every signature.",
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
      "Call graph: direct or transitive indexed callers/callees (direction=in default). MCP output prioritizes confirmed evidence under 2048 code units with exact omission counts; callersDetailed returns the complete structured result. Absence does not prove deletion is safe.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string", description: "Symbol name or qualified name (file#Class.method)" },
        direction: { type: "string", enum: ["in", "out"], description: "in = callers (default), out = callees" },
        depth: { type: "number", description: "Transitive depth (default 1)" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "osnova_groundwork",
    description:
      "Repository map: compact deterministic workspace map. MCP defaults to eight directory clusters and 2048 code units with explicit dropped-detail counts; the map API supports larger structured results.",
    inputSchema: {
      type: "object" as const,
      properties: {
        maxDirs: { type: "number", description: "Maximum directory clusters (default 16)" },
      },
    },
  },
  {
    name: "osnova_footing",
    description:
      "Task context: definitions, graph relationships and candidate tests around a question or named symbols, sized for one task (understand, change or review). MCP output stays under 8192 code units with exact omission counts; the taskContext API returns the complete structured result.",
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
      "Change impact: symbols whose spans a unified diff touches, plus their indexed dependents, against the current index only. Deleted symbols are not visible and diff ranges are not verified against source. MCP output stays under 4096 code units; the impact API compares two indexes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        diff: { type: "string", description: "Unified diff text with a/ b/ or plain repo-relative paths" },
        depth: { type: "number", description: "Dependent walk depth (default 1)" },
      },
      required: ["diff"],
    },
  },
] as const;

type CanonicalToolName = (typeof canonicalToolDefinitions)[number]["name"];

const deprecatedToolAliases: ReadonlyMap<string, CanonicalToolName> = new Map([
  ["osnova_ask", "osnova_ground"],
  ["osnova_find_text", "osnova_thread"],
  ["osnova_skeleton", "osnova_outline"],
  ["osnova_callers", "osnova_warp"],
  ["osnova_map", "osnova_groundwork"],
]);

const toolDefinitions = [
  ...canonicalToolDefinitions,
  ...[...deprecatedToolAliases].map(([alias, canonical]) => {
    const definition = canonicalToolDefinitions.find((tool) => tool.name === canonical);
    if (definition === undefined) throw new Error(`osnova: alias ${alias} names an unknown tool ${canonical}`);
    return { name: alias, description: `Deprecated alias of ${canonical}; removed in the next release.`, inputSchema: definition.inputSchema };
  }),
];

export interface OsnovaMcpOptions {
  readonly cacheDir?: string;
}

export function createOsnovaMcpServer(
  workspace: string,
  options?: OsnovaMcpOptions,
): { server: Server; refresh: () => Promise<OsnovaIndex> } {
  const cacheDir = resolveCacheDir(options?.cacheDir);
  const absRoot = path.resolve(workspace);
  async function refresh(): Promise<OsnovaIndex> {
    return refreshWorkspace(absRoot, { cacheDir, reuseMemory: true });
  }

  const server = new Server(
    { name: "osnova", version: OSNOVA_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = deprecatedToolAliases.get(request.params.name) ?? request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const index = await refresh();
      const generation = `osnova generation ${indexGeneration(index)}`;
      const prefix = [generation, formatIndexHealthSummary(index)].filter(Boolean).join("\n");
      switch (name) {
        case "osnova_ground": {
          const question = requireString(args, "question");
          const result = ask(index, question, {
            in: optionalString(args, "in"),
            limit: optionalNumber(args, "limit"),
            full: optionalBoolean(args, "full"),
          });
          return textResult(`${prefix}\n${formatAsk(result)}`);
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
            limit: optionalNumber(args, "limit"), maxDepth: optionalNumber(args, "depth"), maxCodeUnits: available, excerptLines: mcpFootingExcerptLines,
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
        default:
          return errorResult(`unknown tool ${JSON.stringify(name)}`);
      }
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error), toolErrorBudget(name));
    }
  });

  return { server, refresh };
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
  const { server } = createOsnovaMcpServer(workspace, options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

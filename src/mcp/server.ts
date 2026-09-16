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
import { formatAsk, formatCallersDetailedBounded, formatFindTextResult, formatIndexHealthSummary, formatSkeletonBounded } from "../query/format.js";
import { maximumOsnovaMapCardCodeUnits, type OsnovaIndex } from "../types.js";
import { boundText } from "../query/budget.js";

const OSNOVA_VERSION = "0.2.0";
const maximumMcpSkeletonCodeUnits = 4_096;
const maximumMcpCallersCodeUnits = 2_048;
const maximumMcpMapCodeUnits = 2_048;

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
        default:
          return errorResult(`unknown tool ${JSON.stringify(name)}`);
      }
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  return { server, refresh };
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: boundText(text) }] };
}

function errorResult(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { ...textResult(`osnova error: ${message}`), isError: true };
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

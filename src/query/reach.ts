import path from "node:path";
import type { OsnovaEdge, OsnovaIndex, OsnovaSymbol, ReachDepthTwo, ReachSpread, SymbolReach } from "../types.js";
import { unresolvedCallsByName } from "./callers.js";
import { collectTestImports, isIndexedTestEdge } from "./tests.js";

export const reachDepthTwoCap = 2_000;

export interface ReachOptions {
  readonly depth?: 1 | 2 | undefined;
}

export function dirOf(filePath: string): string {
  const dir = path.posix.dirname(filePath);
  return dir === "." ? "." : `${dir}/`;
}

export function depthOneReach(index: OsnovaIndex, qualifiedName: string): ReachSpread {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const edges = index.incoming(qualifiedName);
  for (const edge of edges) {
    files.add(edge.fromFile);
    dirs.add(dirOf(edge.fromFile));
  }
  return { edges: edges.length, files: files.size, dirs: dirs.size };
}

function depthTwoReach(index: OsnovaIndex, qualifiedName: string): ReachDepthTwo {
  const visited = new Set<string>([qualifiedName]);
  const frontier: string[] = [];
  for (const edge of index.incoming(qualifiedName)) {
    const caller = edge.fromSymbol;
    if (caller.length === 0 || visited.has(caller) || !index.symbols.has(caller)) continue;
    visited.add(caller);
    frontier.push(caller);
  }
  const files = new Set<string>();
  let edges = 0;
  for (const node of frontier) {
    for (const edge of index.incoming(node)) {
      if (edges >= reachDepthTwoCap) return { edges, files: files.size, capped: true };
      edges += 1;
      files.add(edge.fromFile);
    }
  }
  return { edges, files: files.size, capped: false };
}

export function reachCounter(index: OsnovaIndex): (symbol: OsnovaSymbol, options?: ReachOptions) => SymbolReach {
  let unresolvedByName: ReadonlyMap<string, readonly OsnovaEdge[]> | undefined;
  let testImports: ReturnType<typeof collectTestImports> | undefined;
  return (symbol, options) => {
    unresolvedByName ??= unresolvedCallsByName(index);
    testImports ??= collectTestImports(index);
    const d1 = depthOneReach(index, symbol.qualifiedName);
    const testFiles = new Set<string>();
    for (const edge of index.incoming(symbol.qualifiedName)) if (isIndexedTestEdge(index, edge)) testFiles.add(edge.fromFile);
    for (const file of testImports.get(symbol.file)?.keys() ?? []) testFiles.add(file);
    return {
      d1,
      ...(options?.depth === 2 && d1.edges > 0 ? { d2: depthTwoReach(index, symbol.qualifiedName) } : {}),
      unresolvedSameName: unresolvedByName.get(symbol.name)?.length ?? 0,
      tests: testFiles.size,
    };
  };
}

export function formatReach(reach: SymbolReach): string {
  const parts = [reach.d1.edges === 0 ? "d1 callers 0" : `d1 callers ${reach.d1.edges} in ${reach.d1.files} files (${reach.d1.dirs} dirs)`];
  if (reach.d2 !== undefined) parts.push(reach.d2.capped ? `d2 >${reachDepthTwoCap}` : `d2 +${reach.d2.edges} in ${reach.d2.files} files`);
  parts.push(`unresolved same-name ${reach.unresolvedSameName}`, `tests ${reach.tests}`);
  return `reach: ${parts.join("; ")}`;
}

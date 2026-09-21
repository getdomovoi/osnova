import type { DirCluster, HubEntry, MapOptions, MapResult, OsnovaIndex } from "../types.js";
import { depthOneReach, dirOf } from "./reach.js";

const DEFAULT_MAX_DIRS = 16;
const HUBS_PER_DIR = 3;
const HOTSPOT_LIMIT = 10;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export function map(index: OsnovaIndex, options?: MapOptions): MapResult {
  const maxDirs = Math.max(1, options?.maxDirs ?? DEFAULT_MAX_DIRS);

  interface DirStat {
    dir: string;
    files: number;
    symbols: number;
    internal: number;
    external: number;
    symbolQs: string[];
  }
  const dirStats = new Map<string, DirStat>();
  for (const [filePath, card] of index.files) {
    const dir = dirOf(filePath);
    let stat = dirStats.get(dir);
    if (stat === undefined) {
      stat = { dir, files: 0, symbols: 0, internal: 0, external: 0, symbolQs: [] };
      dirStats.set(dir, stat);
    }
    stat.files += 1;
    stat.symbols += card.symbols.length;
    for (const symbol of card.symbols) stat.symbolQs.push(symbol.qualifiedName);
  }

  for (const edge of index.edges) {
    const fromDir = dirOf(edge.fromFile);
    const from = dirStats.get(fromDir);
    const toDir = edge.toFile !== undefined ? dirOf(edge.toFile) : undefined;
    if (toDir !== undefined && toDir === fromDir) {
      if (from !== undefined) from.internal += 1;
      const to = dirStats.get(toDir);
      if (to !== undefined && toDir !== fromDir) to.internal += 1;
    } else {
      if (from !== undefined) from.external += 1;
      if (toDir !== undefined) {
        const to = dirStats.get(toDir);
        if (to !== undefined) to.external += 1;
      }
    }
  }

  const degreeOf = (qualifiedName: string): HubEntry => {
    const symbol = index.symbols.get(qualifiedName);
    const reach = depthOneReach(index, qualifiedName);
    const outEdges = index.outgoing(qualifiedName).length;
    return {
      qualifiedName,
      kind: symbol?.kind ?? "function",
      file: symbol?.file ?? "",
      line: symbol?.span.startLine ?? 0,
      inEdges: reach.edges,
      inFiles: reach.files,
      outEdges,
    };
  };

  const clusters: DirCluster[] = [];
  for (const stat of dirStats.values()) {
    const rankedHubs = stat.symbolQs
      .map(degreeOf)
      .filter((hub) => hub.inEdges + hub.outEdges > 0)
      .sort(
        (a, b) =>
          b.inEdges + b.outEdges - (a.inEdges + a.outEdges) ||
          compare(a.qualifiedName, b.qualifiedName),
      );
    const hubs = rankedHubs.slice(0, HUBS_PER_DIR);
    clusters.push({
      dir: stat.dir,
      fileCount: stat.files,
      symbolCount: stat.symbols,
      internalEdges: stat.internal,
      externalEdges: stat.external,
      hubs,
      droppedHubs: rankedHubs.length - hubs.length,
    });
  }
  clusters.sort(
    (a, b) =>
      b.internalEdges + b.externalEdges - (a.internalEdges + a.externalEdges) ||
      b.symbolCount - a.symbolCount ||
      compare(a.dir, b.dir),
  );

  const rankedHotspots = [...index.symbols.keys()]
    .map(degreeOf)
    .filter((hub) => hub.inEdges + hub.outEdges > 0)
    .sort(
      (a, b) =>
        b.inEdges + b.outEdges - (a.inEdges + a.outEdges) ||
        compare(a.qualifiedName, b.qualifiedName),
    );
  const hotspots = rankedHotspots.slice(0, HOTSPOT_LIMIT);

  return {
    fileCount: index.files.size,
    symbolCount: index.symbols.size,
    edgeCount: index.edges.length,
    clusters: clusters.slice(0, maxDirs),
    hotspots,
    droppedDirs: Math.max(0, clusters.length - maxDirs),
    droppedHotspots: rankedHotspots.length - hotspots.length,
  };
}

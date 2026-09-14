import { freshness } from "../index/incremental.js";
import { maximumOsnovaMapCardCodeUnits } from "../types.js";
import type { MapCardOptions, MapResult, OsnovaIndex } from "../types.js";
import { map as computeMap } from "./map.js";

interface CardLine {
  readonly text: string;
  readonly rank: number;
}

const RANK_HEADER = 0;
const RANK_CLUSTER = 1;
const RANK_HUB = 2;
const RANK_HOTSPOT = 3;
const RANK_SECTION = 4;

export async function renderMapCard(
  index: OsnovaIndex,
  options?: MapCardOptions,
): Promise<string> {
  const maxCodeUnits = options?.maxCodeUnits ?? maximumOsnovaMapCardCodeUnits;
  let staleCount = options?.staleCount;
  if (staleCount === undefined) {
    try {
      const report = await freshness(index, index.root);
      staleCount = report.added.length + report.changed.length + report.deleted.length;
    } catch {
      staleCount = -1;
    }
  }
  const mapResult: MapResult = computeMap(index, { maxDirs: options?.maxDirs });

  const lines: CardLine[] = [];
  const staleText =
    staleCount === 0 ? "fresh" : staleCount === undefined || staleCount < 0 ? "stale: unknown" : `stale: ${staleCount} file${staleCount === 1 ? "" : "s"}`;
  lines.push({
    text: `osnova ${basename(index.root)} | files ${mapResult.fileCount} | symbols ${mapResult.symbolCount} | edges ${mapResult.edgeCount} | ${staleText}`,
    rank: RANK_HEADER,
  });

  for (const cluster of mapResult.clusters) {
    lines.push({
      text: `${cluster.dir} (${cluster.fileCount} files, ${cluster.symbolCount} symbols, ${cluster.internalEdges} int / ${cluster.externalEdges} ext edges)`,
      rank: RANK_CLUSTER,
    });
    for (const hub of cluster.hubs) {
      lines.push({
        text: `  hub ${hub.qualifiedName} (in ${hub.inEdges}, out ${hub.outEdges}) ${hub.file}:${hub.line}`,
        rank: RANK_HUB,
      });
    }
  }

  if (mapResult.hotspots.length > 0) {
    lines.push({ text: "hotspots:", rank: RANK_SECTION });
    for (const hotspot of mapResult.hotspots) {
      lines.push({
        text: `  ${hotspot.qualifiedName} (in ${hotspot.inEdges}, out ${hotspot.outEdges}) ${hotspot.file}:${hotspot.line}`,
        rank: RANK_HOTSPOT,
      });
    }
  }

  const dropped: Partial<Record<number, number>> = {};
  const fitted = fitLines(lines, maxCodeUnits, (rank) => {
    dropped[rank] = (dropped[rank] ?? 0) + 1;
  });

  const droppedClusters = mapResult.droppedDirs + (dropped[RANK_CLUSTER] ?? 0);
  const droppedHubs = dropped[RANK_HUB] ?? 0;
  const droppedHotspots = dropped[RANK_HOTSPOT] ?? 0;
  if (droppedClusters > 0 || droppedHubs > 0 || droppedHotspots > 0) {
    const parts: string[] = [];
    if (droppedClusters > 0) parts.push(`${droppedClusters} cluster lines`);
    if (droppedHubs > 0) parts.push(`${droppedHubs} hub lines`);
    if (droppedHotspots > 0) parts.push(`${droppedHotspots} hotspot lines`);
    fitted.push(`dropped: ${parts.join(", ")}`);
  }

  let card = fitted.join("\n");
  if (card.length > maxCodeUnits) {
    card = card.slice(0, Math.max(0, maxCodeUnits - 1)) + "…";
  }
  return card;
}

function fitLines(
  lines: readonly CardLine[],
  maxCodeUnits: number,
  onDrop: (rank: number) => void,
): string[] {
  const totalUnits = (): number => lines.reduce((acc, line) => acc + line.text.length + 1, 0);
  let remaining = [...lines];
  const dropRanks = [RANK_HOTSPOT, RANK_SECTION, RANK_HUB, RANK_CLUSTER];
  for (const rank of dropRanks) {
    while (totalUnits() > maxCodeUnits) {
      const index = findLastIndexOfRank(remaining, rank);
      if (index === -1) break;
      onDrop(rank === RANK_SECTION ? RANK_HOTSPOT : rank);
      remaining = remaining.filter((_, i) => i !== index);
    }
    if (totalUnits() <= maxCodeUnits) break;
  }
  return remaining.map((line) => line.text);
}

function findLastIndexOfRank(lines: readonly CardLine[], rank: number): number {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line !== undefined && line.rank === rank) return i;
  }
  return -1;
}

function basename(p: string): string {
  const normalized = p.replace(/[\\/]+$/, "");
  const idx = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

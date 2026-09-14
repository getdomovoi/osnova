import type {
  AskResult,
  CallersResult,
  FindTextGroup,
  MapResult,
  SkeletonResult,
} from "../types.js";

export function formatAsk(result: AskResult): string {
  if (result.hits.length === 0) return "no matches";
  const blocks: string[] = [];
  for (const hit of result.hits) {
    const header = `${hit.file}:${hit.line}${hit.symbol !== null ? ` ${hit.symbol.kind} ${hit.symbol.qualifiedName}` : ""}`;
    const numbered = hit.excerpt
      .split("\n")
      .map((line, i) => `L${hit.excerptStartLine + i}: ${line}`)
      .join("\n");
    blocks.push(`${header}\n${numbered}`);
  }
  return blocks.join("\n\n");
}

export function formatFindText(groups: readonly FindTextGroup[]): string {
  if (groups.length === 0) return "no matches";
  const blocks: string[] = [];
  for (const group of groups) {
    const label =
      group.symbol !== null
        ? `${group.symbol.kind} ${group.symbol.qualifiedName} (${group.incomingEdges} in)`
        : `<module> ${group.file} (${group.incomingEdges} in)`;
    const hits = group.matches
      .map((match) => `${group.file}:${match.line}:${match.col + 1}: ${match.text.trim()}`)
      .join("\n");
    blocks.push(`${label}\n${hits}`);
  }
  return blocks.join("\n");
}

export function formatSkeleton(result: SkeletonResult): string {
  const header = `${result.file} (${result.language}, ${result.lineCount} lines, ${result.entries.length} symbols)`;
  const lines = result.entries.map(
    (entry) => `${entry.symbol.kind} ${entry.symbol.name} (L${entry.symbol.span.startLine}-L${entry.symbol.span.endLine}): ${entry.signature}`,
  );
  return [header, ...lines].join("\n");
}

export function formatCallers(result: CallersResult): string {
  const target = `${result.target.kind} ${result.target.qualifiedName}`;
  if (result.hits.length === 0) return `${target}: no edges`;
  const lines = result.hits.map((hit) => {
    const label =
      hit.symbol !== null
        ? `${hit.symbol.kind} ${hit.qualifiedName}`
        : hit.qualifiedName.length > 0
          ? hit.qualifiedName
          : "<module>";
    const where = hit.file !== null ? ` ${hit.file}:${hit.line ?? 0}` : "";
    return `d${hit.depth} ${hit.kind} ${label}${where}`;
  });
  return [`${target}: ${result.hits.length} edges`, ...lines].join("\n");
}

export function formatMap(result: MapResult): string {
  const lines: string[] = [
    `files ${result.fileCount} | symbols ${result.symbolCount} | edges ${result.edgeCount}${result.droppedDirs > 0 ? ` | dropped ${result.droppedDirs} dirs` : ""}`,
  ];
  for (const cluster of result.clusters) {
    lines.push(
      `${cluster.dir} (${cluster.fileCount} files, ${cluster.symbolCount} symbols, ${cluster.internalEdges} int / ${cluster.externalEdges} ext edges)`,
    );
    for (const hub of cluster.hubs) {
      lines.push(`  hub ${hub.qualifiedName} (in ${hub.inEdges}, out ${hub.outEdges}) ${hub.file}:${hub.line}`);
    }
  }
  if (result.hotspots.length > 0) {
    lines.push("hotspots:");
    for (const hotspot of result.hotspots) {
      lines.push(`  ${hotspot.qualifiedName} (in ${hotspot.inEdges}, out ${hotspot.outEdges}) ${hotspot.file}:${hotspot.line}`);
    }
  }
  return lines.join("\n");
}

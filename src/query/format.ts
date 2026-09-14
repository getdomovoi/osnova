import type {
  AskResult,
  CallersResult,
  CallersDetailedResult,
  FindTextGroup,
  FindTextResult,
  MapResult,
  SkeletonResult,
  OsnovaIndex,
} from "../types.js";

export function formatIndexDiagnostics(index: OsnovaIndex): string {
  if (index.diagnostics === undefined) return "partial analysis: index health is unverified";
  if (index.diagnostics.length === 0) return "";
  const lines = [`partial analysis: ${index.diagnostics.length} diagnostics; results may be incomplete`];
  for (const diagnostic of index.diagnostics.slice(0, 10)) {
    lines.push(`${diagnostic.phase} ${diagnostic.path}: ${diagnostic.code}`);
  }
  if (index.diagnostics.length > 10) lines.push(`${index.diagnostics.length - 10} diagnostics omitted; inspect indexHealth for all diagnostics`);
  return lines.join("\n");
}

export function formatAsk(result: AskResult): string {
  if (result.hits.length === 0) return "no matches";
  const blocks: string[] = [];
  for (const hit of result.hits) {
    const header = `${hit.file}:${hit.line}${hit.symbol !== null ? ` ${hit.symbol.kind} ${hit.symbol.qualifiedName}` : ""}`;
    const numbered = hit.excerpt
      .split("\n")
      .map((line, i) => `L${hit.excerptStartLine + i}: ${line}`)
      .join("\n");
    const endLine = hit.excerptStartLine + hit.excerpt.split("\n").length - 1;
    const excerptNotice = hit.symbol !== null &&
      (hit.excerptStartLine > hit.symbol.span.startLine || endLine < hit.symbol.span.endLine)
      ? `\nexcerpt: lines ${hit.excerptStartLine}-${endLine} of definition lines ${hit.symbol.span.startLine}-${hit.symbol.span.endLine}` : "";
    blocks.push(`${header}${excerptNotice}\n${numbered}`);
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

export function formatFindTextResult(result: FindTextResult): string {
  const shown = result.totalMatches - result.omittedMatches;
  const summary = `indexed-text search: ${shown}/${result.totalMatches} matches, ${result.groups.length}/${result.totalGroups} groups`;
  const lines = [summary];
  if (result.truncated) {
    lines.push(`truncated: ${result.omittedMatches} matches omitted; ${result.omittedGroups} groups omitted`);
    lines.push("Use findTextDetailed without limits to retrieve all matches in indexed text.");
  }
  if (result.totalMatches === 0) lines.push("no matches in indexed text");
  else if (result.groups.length > 0) lines.push(formatFindText(result.groups));
  return lines.join("\n");
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

export function formatCallersDetailed(result: CallersDetailedResult): string {
  if (result.status === "ambiguous") {
    return [
      "ambiguous symbol: use a qualified name to select a target",
      ...result.candidates.map((symbol) => `${symbol.qualifiedName} ${symbol.file}:${symbol.span.startLine}`),
    ].join("\n");
  }
  const lines = ["indexed-graph results; relationships use heuristic resolution, not type inference"];
  if (result.hits.length === 0) {
    lines.push(`${result.target.qualifiedName}: no indexed relationships found`);
  } else {
    lines.push(`${result.target.kind} ${result.target.qualifiedName}: ${result.hits.length} indexed edges`);
    for (const hit of result.hits) {
      const evidence = hit.edge.evidence;
      const basis = evidence?.source === "syntax" ? evidence.resolution.status === "resolved"
        ? evidence.resolution.method : evidence.resolution.status : "unknown provenance";
      lines.push(`d${hit.depth} ${hit.kind} ${hit.qualifiedName || "<module>"} ${hit.file ?? "?"}:${hit.line ?? 0} [${basis}; source ${hit.edge.fromFile}:${hit.edge.line}]`);
      if (evidence?.source === "syntax" && evidence.resolution.status === "resolved" && evidence.resolution.method === "re-export-binding") {
        for (const hop of evidence.resolution.via) lines.push(`  via ${hop.file}:${hop.line} ${hop.exportedName} -> ${hop.targetFile} (export ${hop.importedName})`);
      }
    }
  }
  lines.push("This does not prove absence of callers or that deletion is safe.");
  if (result.unresolved.length > 0) {
    lines.push(`unresolved evidence (${result.unresolved.length}); not confirmed relationships`);
    for (const { edge, depth } of result.unresolved) {
      lines.push(`d${depth} ${edge.kind} ${edge.toName} ${edge.fromFile}:${edge.line}`);
      if (edge.evidence?.source === "syntax" && edge.evidence.resolution.status === "unresolved") {
        lines.push(`  reason: ${edge.evidence.resolution.reason}`);
      }
      if (edge.evidence?.source === "syntax" && edge.evidence.resolution.status === "ambiguous") {
        lines.push(`  ambiguous candidates: ${edge.evidence.resolution.candidates.join(", ")}`);
      }
    }
  }
  return lines.join("\n");
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

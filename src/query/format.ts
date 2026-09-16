import type {
  AskResult,
  CallersResult,
  CallersDetailedResult,
  FindTextGroup,
  FindTextResult,
  MapResult,
  SkeletonResult,
  OsnovaIndex,
  CallerEvidenceHit,
  OsnovaEdge,
} from "../types.js";
import type { ImpactResult } from "./impact.js";
import type { TaskContextResult } from "./task-context.js";

export function formatIndexDiagnostics(index: OsnovaIndex): string {
  if (index.diagnostics === undefined) return "osnova foundation: unverified; index health could not be checked";
  if (index.diagnostics.length === 0) return "";
  const lines = [`osnova foundation: partial, ${index.diagnostics.length} diagnostics; results may be incomplete`];
  for (const diagnostic of index.diagnostics.slice(0, 10)) {
    lines.push(`${diagnostic.phase} ${diagnostic.path}: ${diagnostic.code}`);
  }
  if (index.diagnostics.length > 10) lines.push(`${index.diagnostics.length - 10} diagnostics omitted; inspect indexHealth for all diagnostics`);
  return lines.join("\n");
}

export function formatIndexHealthSummary(index: OsnovaIndex): string {
  if (index.diagnostics === undefined) return "osnova foundation: unverified; details via doctor or indexHealth";
  if (index.diagnostics.length === 0) return "";
  const counts = new Map<string, number>();
  for (const diagnostic of index.diagnostics) {
    const code = diagnostic.code.replace(/[^a-zA-Z0-9_.-]/g, "?").slice(0, 64);
    const category = `${diagnostic.phase}/${code}`;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const categories = [...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const shown = categories.slice(0, 4).map(([category, count]) => `${category}=${count}`);
  if (categories.length > 4) shown.push(`+${categories.length - 4} categories`);
  return `osnova foundation: partial, ${index.diagnostics.length} diagnostics (${shown.join(", ")}); results may be incomplete; details via doctor or indexHealth`;
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

export function formatSkeletonBounded(index: OsnovaIndex, result: SkeletonResult, maxCodeUnits: number): string {
  if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits < 256) {
    throw new RangeError("osnova: skeleton budget must be a safe integer of at least 256 code units");
  }
  const complete = formatSkeleton(result);
  if (complete.length <= maxCodeUnits) return complete;
  const metadata = ` (${result.language}, ${result.lineCount} lines, ${result.entries.length} symbols)`;
  const emptyFooter = `omitted: ${result.entries.length} of ${result.entries.length} signatures; selected by indexed edge degree, then source order. Use skeleton API for the complete file.`;
  const availablePath = Math.max(8, maxCodeUnits - metadata.length - emptyFooter.length - 2);
  const header = `${compactField(result.file, availablePath)}${metadata}`;
  const line = (entry: SkeletonResult["entries"][number]): string =>
    `${entry.symbol.kind} ${entry.symbol.name} (L${entry.symbol.span.startLine}-L${entry.symbol.span.endLine}): ${entry.signature}`;
  const ranked = [...result.entries].sort((a, b) => {
    const aDegree = index.incoming(a.symbol.qualifiedName).length + index.outgoing(a.symbol.qualifiedName).length;
    const bDegree = index.incoming(b.symbol.qualifiedName).length + index.outgoing(b.symbol.qualifiedName).length;
    return bDegree - aDegree || a.symbol.span.startLine - b.symbol.span.startLine ||
      a.symbol.span.startCol - b.symbol.span.startCol || (a.symbol.qualifiedName < b.symbol.qualifiedName ? -1 : 1);
  });
  const selected: SkeletonResult["entries"][number][] = [];
  for (const entry of ranked) {
    const candidate = [...selected, entry].sort((a, b) => a.symbol.span.startLine - b.symbol.span.startLine ||
      a.symbol.span.startCol - b.symbol.span.startCol || (a.symbol.qualifiedName < b.symbol.qualifiedName ? -1 : 1));
    const omitted = result.entries.length - candidate.length;
    const footer = `omitted: ${omitted} of ${result.entries.length} signatures; selected by indexed edge degree, then source order. Use skeleton API for the complete file.`;
    if ([header, ...candidate.map(line), footer].join("\n").length <= maxCodeUnits) selected.push(entry);
  }
  selected.sort((a, b) => a.symbol.span.startLine - b.symbol.span.startLine ||
    a.symbol.span.startCol - b.symbol.span.startCol || (a.symbol.qualifiedName < b.symbol.qualifiedName ? -1 : 1));
  const omitted = result.entries.length - selected.length;
  return [header, ...selected.map(line), `omitted: ${omitted} of ${result.entries.length} signatures; selected by indexed edge degree, then source order. Use skeleton API for the complete file.`].join("\n");
}

function compactField(value: string, maxCodeUnits: number): string {
  if (value.length <= maxCodeUnits) return value;
  if (maxCodeUnits <= 1) return "…".slice(0, maxCodeUnits);
  const left = Math.ceil((maxCodeUnits - 1) / 2);
  const right = Math.floor((maxCodeUnits - 1) / 2);
  return `${value.slice(0, left)}…${right === 0 ? "" : value.slice(-right)}`;
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
      lines.push(...callerHitLines(hit));
    }
  }
  lines.push("This does not prove absence of callers or that deletion is safe.");
  if (result.unresolved.length > 0) {
    lines.push(`unresolved evidence (${result.unresolved.length}); not confirmed relationships`);
    for (const { edge, depth } of result.unresolved) {
      lines.push(...unresolvedCallerLines(edge, depth));
    }
  }
  return lines.join("\n");
}

function callerHitLines(hit: CallerEvidenceHit): string[] {
  const evidence = hit.edge.evidence;
  const basis = evidence?.source === "syntax" ? evidence.resolution.status === "resolved"
    ? evidence.resolution.method : evidence.resolution.status : "unknown provenance";
  const lines = [`d${hit.depth} ${hit.kind} ${hit.qualifiedName || "<module>"} ${hit.file ?? "?"}:${hit.line ?? 0} [${basis}; source ${hit.edge.fromFile}:${hit.edge.line}]`];
  if (evidence?.source === "syntax" && evidence.resolution.status === "resolved") {
    if (evidence.resolution.method === "receiver-hint") {
      const receiver = evidence.resolution.receiver;
      lines.push(`  receiver hint: ${receiver.classSymbol} (${receiver.mode}, ${receiver.basis}); not runtime type proof`);
    }
    for (const hop of evidence.resolution.via ?? []) lines.push(`  via ${hop.file}:${hop.line} ${hop.exportedName} -> ${hop.targetFile} (export ${hop.importedName})`);
  }
  return lines;
}

function unresolvedCallerLines(edge: OsnovaEdge, depth: number): string[] {
  const lines = [`d${depth} ${edge.kind} ${edge.toName} ${edge.fromFile}:${edge.line}`];
  if (edge.evidence?.source === "syntax" && edge.evidence.resolution.status === "unresolved") {
    lines.push(`  reason: ${edge.evidence.resolution.reason}`);
  }
  if (edge.evidence?.source === "syntax" && edge.evidence.resolution.status === "ambiguous") {
    lines.push(`  ambiguous candidates: ${edge.evidence.resolution.candidates.join(", ")}`);
  }
  return lines;
}

export function formatCallersDetailedBounded(result: CallersDetailedResult, maxCodeUnits: number): string {
  if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits < 512) {
    throw new RangeError("osnova: caller budget must be a safe integer of at least 512 code units");
  }
  const complete = formatCallersDetailed(result);
  if (complete.length <= maxCodeUnits) return complete;
  if (result.status === "ambiguous") {
    const header = "ambiguous symbol: use a qualified name to select a target";
    const selected: string[] = [];
    for (const symbol of result.candidates) {
      const line = `${symbol.qualifiedName} ${symbol.file}:${symbol.span.startLine}`;
      const omitted = result.candidates.length - selected.length - 1;
      const footer = `omitted: ${omitted} of ${result.candidates.length} ambiguous candidates. Use callersDetailed API for the complete candidate list.`;
      if ([header, ...selected, line, footer].join("\n").length <= maxCodeUnits) selected.push(line);
    }
    return [header, ...selected, `omitted: ${result.candidates.length - selected.length} of ${result.candidates.length} ambiguous candidates. Use callersDetailed API for the complete candidate list.`].join("\n");
  }
  const base = [
    "indexed-graph results; relationships use heuristic resolution, not type inference",
    "This does not prove absence of callers or that deletion is safe.",
  ];
  const hitBlocks = result.hits.map(callerHitLines);
  const unresolvedBlocks = result.unresolved.map(({ edge, depth }) => unresolvedCallerLines(edge, depth));
  const selectedHits: string[][] = [];
  const selectedUnresolved: string[][] = [];
  const footer = (): string => `omitted: ${hitBlocks.length - selectedHits.length} of ${hitBlocks.length} confirmed relationships; ${unresolvedBlocks.length - selectedUnresolved.length} of ${unresolvedBlocks.length} unresolved evidence items. Use callersDetailed API for complete structured results.`;
  const targetSuffix = `: ${result.hits.length} indexed edges`;
  const fixedUnits = [...base, footer()].join("\n").length + targetSuffix.length + 2;
  const target = `${result.target.kind} ${compactField(result.target.qualifiedName, Math.max(1, maxCodeUnits - fixedUnits - result.target.kind.length - 1))}${targetSuffix}`;
  const fixed = [base[0] ?? "", target, base[1] ?? ""];
  const unresolvedHeader = `unresolved evidence (${result.unresolved.length}); not confirmed relationships`;
  const fits = (block: string[], unresolved: boolean): boolean => [
    ...fixed, ...selectedHits.flat(),
    ...(selectedUnresolved.length > 0 || unresolved ? [unresolvedHeader] : []),
    ...selectedUnresolved.flat(), ...block, footer(),
  ].join("\n").length <= maxCodeUnits;
  for (const block of hitBlocks) if (fits(block, false)) selectedHits.push(block);
  for (const block of unresolvedBlocks) if (fits(block, true)) selectedUnresolved.push(block);
  return [
    ...fixed, ...selectedHits.flat(),
    ...(selectedUnresolved.length > 0 ? [unresolvedHeader, ...selectedUnresolved.flat()] : []),
    footer(),
  ].join("\n");
}

export function formatMap(result: MapResult): string {
  const lines: string[] = [
    `files ${result.fileCount} | symbols ${result.symbolCount} | edges ${result.edgeCount}${result.droppedDirs > 0 ? ` | dropped ${result.droppedDirs} dirs` : ""}${result.droppedHotspots > 0 ? ` | dropped ${result.droppedHotspots} hotspots` : ""}`,
  ];
  for (const cluster of result.clusters) {
    lines.push(
      `${cluster.dir} (${cluster.fileCount} files, ${cluster.symbolCount} symbols, ${cluster.internalEdges} int / ${cluster.externalEdges} ext edges)`,
    );
    for (const hub of cluster.hubs) {
      lines.push(`  hub ${hub.qualifiedName} (in ${hub.inEdges}, out ${hub.outEdges}) ${hub.file}:${hub.line}`);
    }
    if (cluster.droppedHubs > 0) lines.push(`  omitted ${cluster.droppedHubs} hubs`);
  }
  if (result.hotspots.length > 0) {
    lines.push("hotspots:");
    for (const hotspot of result.hotspots) {
      lines.push(`  ${hotspot.qualifiedName} (in ${hotspot.inEdges}, out ${hotspot.outEdges}) ${hotspot.file}:${hotspot.line}`);
    }
  }
  return lines.join("\n");
}

const contextExcerptLines = 8;

export function formatTaskContext(result: TaskContextResult): string {
  const lines = [
    `osnova footing: ${result.task}, scope ${result.scope === "" ? "." : result.scope}, ${result.definitions.length} definitions, ${result.relationships.length} relationships, ${result.candidateTests.length} candidate tests`,
  ];
  if (result.definitions.length > 0) lines.push("definitions:");
  for (const definition of result.definitions) {
    const { symbol } = definition;
    lines.push(`- ${symbol.qualifiedName} ${symbol.kind} lines ${symbol.span.startLine}-${symbol.span.endLine}`);
    const excerpt = definition.excerpt.split("\n");
    const marker = /^\[\+\d+ more lines\]$/.test(excerpt.at(-1) ?? "") ? excerpt.pop() : undefined;
    for (const line of excerpt.slice(0, contextExcerptLines)) lines.push(`  ${line}`);
    if (marker !== undefined) lines.push(`  ${marker}`);
    else if (excerpt.length > contextExcerptLines) lines.push(`  [+${excerpt.length - contextExcerptLines} more lines]`);
  }
  if (result.relationships.length > 0) lines.push("relationships:");
  for (const relationship of result.relationships) {
    const { edge } = relationship;
    const via = relationship.viaSources.length > 0 ? ` via ${relationship.viaSources.map((source) => source.file).join(", ")}` : "";
    lines.push(`- ${edge.fromSymbol || edge.fromFile} -> ${edge.toSymbol ?? edge.toFile ?? edge.toName} ${edge.kind} line ${edge.line}${via}`);
  }
  if (result.candidateTests.length > 0) lines.push("candidate tests:");
  for (const test of result.candidateTests) lines.push(`- ${test.file}${test.symbol === null ? "" : ` via ${test.symbol.qualifiedName}`}`);
  const omitted = result.omitted;
  lines.push(`omitted: ${omitted.definitions} definitions, ${omitted.relationships} relationships, ${omitted.candidateTests} candidate tests, ${omitted.retrievalHits} lower-ranked candidates, ${omitted.uncertainEdges} uncertain edges, ${omitted.outOfScopeEdges} out-of-scope edges, ${omitted.depthFrontier} depth frontier, ${omitted.unknownSymbols} unknown symbols`);
  lines.push(`limitations: ${result.limitations.join(", ")}`);
  return lines.join("\n");
}

export function formatImpact(result: ImpactResult): string {
  return [
    `osnova settle: ${result.changes.length} symbol changes; ${result.dependents.length} dependents; ${result.omitted.dependentFrontier} frontier items omitted`,
    ...result.changes.map((change) => `${change.kind}: ${change.before?.symbol.qualifiedName ?? "<new>"} -> ${change.after?.symbol.qualifiedName ?? "<deleted>"}`),
    ...result.dependents.map((dependent) => `${dependent.snapshot} d${dependent.depth} ${dependent.symbol?.qualifiedName ?? dependent.file} [source ${dependent.receipt.hash}]`),
    `uncertainty: ${result.uncertainty.unresolvedEdges} unresolved edges; ${result.uncertainty.notes.join(", ")}`,
  ].join("\n");
}

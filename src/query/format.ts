import type {
  AskHit,
  AskResult,
  CallersResult,
  CallersDetailedResult,
  FindTextGroup,
  FindTextMatch,
  FindTextResult,
  MapResult,
  SkeletonResult,
  OsnovaIndex,
  CallerEvidenceHit,
  NameMatches,
  OsnovaEdge,
  EdgeKind,
  UnresolvedCallerEdge,
} from "../types.js";
import { maximumIndexedFileSizeBytes } from "../types.js";
import type { ImpactResult } from "./impact.js";
import type { CoverageReport, LanguageCoverage } from "./coverage.js";
import type { DiagnosticCheck, DoctorReport, LanguageCapability } from "../diagnostics/doctor.js";
import type { PlumbResult } from "./plumb.js";
import type { TaskContextResult } from "./task-context.js";
import { formatReach } from "./reach.js";
import type { SymbolsUnderTestResult, TestFileEvidence, TestSite, TestsForResult } from "./tests.js";
import type { UnreferencedResult } from "./unreferenced.js";
import { entryPointRuleText, unreferencedNotice } from "./unreferenced.js";

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

const notIndexedCategory = "scan/file-too-large";
const sizeCapText = `${maximumIndexedFileSizeBytes / 1_000_000} MB`;

export function formatIndexHealthSummary(index: OsnovaIndex): string {
  if (index.diagnostics === undefined) return "osnova foundation: unverified";
  if (index.diagnostics.length === 0) return "";
  const counts = new Map<string, number>();
  for (const diagnostic of index.diagnostics) {
    const code = diagnostic.code.replace(/[^a-zA-Z0-9_.-]/g, "?").slice(0, 64);
    const category = `${diagnostic.phase}/${code}`;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  // A file above the size cap is absent from the index, so every count that could have included it
  // is short. That is the one category a reader must never find folded into "+N categories".
  const rank = (category: string): number => category === notIndexedCategory ? 0 : 1;
  const categories = [...counts].sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const shown = categories.slice(0, 4).map(([category, count]) => `${category}=${count}`);
  if (categories.length > 4) shown.push(`+${categories.length - 4} categories`);
  const tooLarge = counts.get(notIndexedCategory) ?? 0;
  const reasons: string[] = [];
  if (tooLarge > 0) {
    reasons.push(`${tooLarge} ${tooLarge === 1 ? "file" : "files"} above the ${sizeCapText} size cap ${tooLarge === 1 ? "is" : "are"} not indexed`);
  }
  if (index.diagnostics.some((diagnostic) => diagnostic.phase === "parse")) reasons.push("some files did not parse fully");
  if (reasons.length === 0) reasons.push("results may be incomplete");
  return `osnova foundation: partial (${shown.join(", ")}); ${reasons.join("; ")}`;
}

// The summary above never names files, because it heads every MCP answer. A query about one file is
// the exception: the agent already named that file, and cannot otherwise join the aggregate to it.
export function formatFileDiagnostics(index: OsnovaIndex, file: string): string {
  const entries = index.files.get(file)?.diagnostics ?? [];
  return entries.map((diagnostic) => {
    const effect = diagnostic.code === "file-too-large" ? "this file is not indexed" : "results for this file are incomplete";
    return `osnova: ${file} ${diagnostic.phase}/${diagnostic.code}; ${effect}`;
  }).join("\n");
}

function foldNestedHits(hits: readonly AskHit[]): Map<AskHit, string[]> {
  const shown = new Map<string, AskHit>();
  const folded = new Map<AskHit, string[]>();
  for (const hit of hits) {
    if (hit.symbol === null) continue;
    const name = hit.symbol.qualifiedName;
    let ancestor: AskHit | undefined;
    for (let dot = name.indexOf(".", name.indexOf("#") + 1); dot !== -1; dot = name.indexOf(".", dot + 1)) {
      const candidate = shown.get(name.slice(0, dot));
      if (candidate !== undefined) { ancestor = candidate; break; }
    }
    if (ancestor === undefined || ancestor.symbol === null) {
      if (!shown.has(name)) shown.set(name, hit);
      continue;
    }
    const entries = folded.get(ancestor) ?? [];
    entries.push(`${name.slice(ancestor.symbol.qualifiedName.length)} L${hit.line}`);
    folded.set(ancestor, entries);
    folded.set(hit, []);
  }
  return folded;
}

const leanLineCodeUnits = 200;

function leanLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= leanLineCodeUnits) return flat;
  let end = leanLineCodeUnits - 1;
  const last = flat.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${flat.slice(0, end)}…`;
}

export function leanAskBody(hit: AskHit): string {
  if (hit.symbol !== null) {
    const span = ` lines ${hit.symbol.span.startLine}-${hit.symbol.span.endLine}`;
    const signature = leanLine(hit.symbol.signature);
    return signature.length === 0 ? span : `${span}\n${signature}`;
  }
  const lines = hit.excerpt.split("\n");
  const text = leanLine(lines[hit.line - hit.excerptStartLine] ?? lines[0] ?? "");
  return text.length === 0 ? "" : `\nL${hit.line}: ${text}`;
}

export function formatAsk(result: AskResult, options?: { readonly lean?: boolean | undefined }): string {
  if (result.hits.length === 0) return "no matches";
  const lean = options?.lean ?? false;
  const folded = foldNestedHits(result.hits);
  const blocks: string[] = [];
  for (const hit of result.hits) {
    const also = folded.get(hit);
    if (also !== undefined && also.length === 0) continue;
    const header = `${hit.file}:${hit.line}${hit.symbol !== null ? ` ${hit.symbol.kind} ${hit.symbol.qualifiedName}` : ""}`;
    if (lean) {
      blocks.push(`${header}${leanAskBody(hit)}${also !== undefined ? `\nalso: ${also.join(", ")}` : ""}`);
      continue;
    }
    const numbered = hit.excerpt
      .split("\n")
      .map((line, i) => `L${hit.excerptStartLine + i}: ${line}`)
      .join("\n");
    const endLine = hit.excerptStartLine + hit.excerpt.split("\n").length - 1;
    const excerptNotice = hit.symbol !== null &&
      (hit.excerptStartLine > hit.symbol.span.startLine || endLine < hit.symbol.span.endLine)
      ? `\nexcerpt: lines ${hit.excerptStartLine}-${endLine} of definition lines ${hit.symbol.span.startLine}-${hit.symbol.span.endLine}` : "";
    const alsoLine = also !== undefined ? `\nalso: ${also.join(", ")}` : "";
    blocks.push(`${header}${excerptNotice}\n${numbered}${alsoLine}`);
  }
  return blocks.join("\n\n");
}


const threadWindowCodeUnits = 120;

interface ThreadRow {
  readonly line: number;
  readonly cols: number[];
  readonly text: string;
  start: number;
  end: number;
}

export function clipThreadText(text: string, spanStart: number, spanEnd: number, window = threadWindowCodeUnits): string {
  const indent = text.length - text.trimStart().length;
  const trimmed = text.trim();
  const from = Math.max(0, Math.min(spanStart - indent, trimmed.length));
  const to = Math.max(from, Math.min(spanEnd - indent, trimmed.length));
  if (trimmed.length <= window) return trimmed;
  const span = to - from;
  let start: number;
  let end: number;
  if (span >= window) {
    start = from;
    end = to;
  } else {
    start = Math.max(0, from - Math.floor((window - span) / 2));
    end = Math.min(trimmed.length, start + window);
    start = Math.max(0, end - window);
  }
  return `${start > 0 ? "…" : ""}${trimmed.slice(start, end)}${end < trimmed.length ? "…" : ""}`;
}

function threadRows(matches: readonly FindTextMatch[]): ThreadRow[] {
  const rows: ThreadRow[] = [];
  for (const match of matches) {
    const last = rows[rows.length - 1];
    if (last !== undefined && last.line === match.line) {
      last.cols.push(match.col + 1);
      last.start = Math.min(last.start, match.col);
      last.end = Math.max(last.end, match.col + match.length);
      continue;
    }
    rows.push({ line: match.line, cols: [match.col + 1], text: match.text, start: match.col, end: match.col + match.length });
  }
  return rows;
}

export function formatFindText(groups: readonly FindTextGroup[]): string {
  if (groups.length === 0) return "no matches";
  const blocks: string[] = [];
  for (const group of groups) {
    const label =
      group.symbol !== null
        ? `${group.symbol.kind} ${group.symbol.qualifiedName} (${group.incomingEdges} in)`
        : `<module> ${group.file} (${group.incomingEdges} in)`;
    const hits = threadRows(group.matches)
      .map((row) => `${group.file}:${row.line}:${row.cols.join(",")}: ${clipThreadText(row.text, row.start, row.end)}`)
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
  const unsearched = result.unsearchedFiles.length;
  if (unsearched > 0) {
    lines.push(`${unsearched} ${unsearched === 1 ? "file in this scope is" : "files in this scope are"} above the ${maximumIndexedFileSizeBytes / 1_000_000} MB size cap and ${unsearched === 1 ? "was" : "were"} not searched: ${result.unsearchedFiles.slice(0, 3).join(", ")}${unsearched > 3 ? `, and ${unsearched - 3} more` : ""}`);
  }
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
  const total = result.entries.length;
  const footerFor = (omitted: number): string =>
    `omitted: ${omitted} of ${total} signatures; selected by indexed edge degree, then source order. Use skeleton API for the complete file.`;
  const availablePath = Math.max(8, maxCodeUnits - metadata.length - footerFor(total).length - 2);
  const header = `${compactField(result.file, availablePath)}${metadata}`;
  type Entry = SkeletonResult["entries"][number];
  const line = (entry: Entry): string =>
    `${entry.symbol.kind} ${entry.symbol.name} (L${entry.symbol.span.startLine}-L${entry.symbol.span.endLine}): ${entry.signature}`;
  const bySource = (a: Entry, b: Entry): number => a.symbol.span.startLine - b.symbol.span.startLine ||
    a.symbol.span.startCol - b.symbol.span.startCol || (a.symbol.qualifiedName < b.symbol.qualifiedName ? -1 : 1);
  const degreeOf = new Map(result.entries.map((entry) => {
    const degree = index.degree(entry.symbol.qualifiedName);
    return [entry, degree.incoming + degree.outgoing] as const;
  }));
  const ranked = [...result.entries].sort((a, b) => degreeOf.get(b)! - degreeOf.get(a)! || bySource(a, b));
  const selected: Entry[] = [];
  let used = header.length;
  for (const entry of ranked) {
    const next = used + 1 + line(entry).length;
    if (next + 1 + footerFor(total - selected.length - 1).length <= maxCodeUnits) {
      selected.push(entry);
      used = next;
    }
  }
  selected.sort(bySource);
  return [header, ...selected.map(line), footerFor(total - selected.length)].join("\n");
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
  }
  if (result.reach !== undefined) lines.push(formatReach(result.reach));
  for (const group of callerGroups(result.hits)) lines.push(...callerGroupLines(group));
  lines.push("This does not prove absence of callers or that deletion is safe.");
  if (result.unresolved.length > 0) {
    lines.push(`unresolved evidence (${result.unresolved.length}); not confirmed relationships`);
    lines.push(...unresolvedGroupLines(unresolvedGroups(result.unresolved)));
  }
  return lines.join("\n");
}

interface CallerGroup {
  readonly depth: number;
  readonly kind: EdgeKind;
  readonly file: string;
  readonly label: string;
  readonly basis: string;
  readonly definitionLine: number | null;
  readonly sites: CallerSite[];
  edges: number;
}

interface CallerSite {
  readonly file: string;
  readonly line: number;
  readonly detail: string[];
}

function edgeBasis(hit: CallerEvidenceHit): string {
  const evidence = hit.edge.evidence;
  return evidence?.source === "syntax" ? evidence.resolution.status === "resolved"
    ? evidence.resolution.method : evidence.resolution.status : "unknown provenance";
}

function routeDetail(edge: OsnovaEdge): string[] {
  return edge.route === undefined ? [] : [`route: ${edge.route.method} ${edge.route.path ?? "(computed path)"}`];
}

function edgeDetail(hit: CallerEvidenceHit): string[] {
  const evidence = hit.edge.evidence;
  const lines: string[] = routeDetail(hit.edge);
  if (evidence?.source === "syntax" && evidence.resolution.status === "resolved") {
    if (evidence.resolution.method === "receiver-hint") {
      const receiver = evidence.resolution.receiver;
      lines.push(`receiver hint: ${receiver.classSymbol} (${receiver.mode}, ${receiver.basis}); not runtime type proof`);
    }
    for (const hop of evidence.resolution.via ?? []) lines.push(`via ${hop.file}:${hop.line} ${hop.exportedName} -> ${hop.targetFile} (export ${hop.importedName})`);
  }
  return lines;
}

function compareGroups(a: CallerGroup, b: CallerGroup): number {
  return a.depth - b.depth || compareText(a.file, b.file) || compareText(a.label, b.label) || compareText(a.basis, b.basis)
    || (a.definitionLine ?? 0) - (b.definitionLine ?? 0) || compareSites(a.sites[0], b.sites[0]);
}

function compareSites(a: CallerSite | undefined, b: CallerSite | undefined): number {
  if (a === undefined || b === undefined) return 0;
  return compareText(a.file, b.file) || a.line - b.line;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function callerGroups(hits: readonly CallerEvidenceHit[]): CallerGroup[] {
  const groups = new Map<string, CallerGroup>();
  for (const hit of hits) {
    const file = hit.file ?? "?";
    const label = hit.qualifiedName.length > 0
      ? hit.qualifiedName.startsWith(`${file}#`) ? hit.qualifiedName : `${hit.qualifiedName} ${file}`
      : `${file}#<module>`;
    const basis = edgeBasis(hit);
    const sameSite = hit.file === hit.edge.fromFile && hit.line === hit.edge.line;
    const definitionLine = sameSite ? null : hit.line ?? 0;
    const key = [hit.depth, hit.kind, file, label, basis, definitionLine ?? ""].join("\0");
    const group = groups.get(key) ?? { depth: hit.depth, kind: hit.kind, file, label, basis, definitionLine, sites: [], edges: 0 };
    const site = { file: sameSite ? file : hit.edge.fromFile, line: sameSite ? hit.line ?? 0 : hit.edge.line, detail: edgeDetail(hit) };
    const existing = group.sites.find((candidate) => candidate.file === site.file && candidate.line === site.line && candidate.detail.join("\n") === site.detail.join("\n"));
    if (existing === undefined) group.sites.push(site);
    group.edges += 1;
    groups.set(key, group);
  }
  const sorted = [...groups.values()];
  for (const group of sorted) group.sites.sort(compareSites);
  sorted.sort(compareGroups);
  return sorted;
}

function siteList(sites: readonly CallerSite[], file: string, cap = Number.POSITIVE_INFINITY): string {
  const byFile = new Map<string, number[]>();
  let total = 0;
  for (const site of sites) {
    const lines = byFile.get(site.file) ?? [];
    if (!lines.includes(site.line)) {
      lines.push(site.line);
      total += 1;
    }
    byFile.set(site.file, lines);
  }
  const more = total > cap ? `,+${total - cap} more` : "";
  let remaining = Math.min(total, cap);
  const entries: string[] = [];
  for (const [siteFile, lines] of byFile) {
    if (remaining <= 0) break;
    const kept = lines.slice(0, remaining);
    remaining -= kept.length;
    entries.push(byFile.size === 1 && siteFile === file ? kept.join(",") : `${siteFile}:${kept.join(",")}`);
  }
  return `${entries.join("; ")}${more}`;
}

function siteCount(group: { readonly sites: readonly CallerSite[] }): number {
  return new Set(group.sites.map((site) => `${site.file}:${site.line}`)).size;
}

function callerGroupLines(group: CallerGroup, cap = Number.POSITIVE_INFINITY): string[] {
  const header = group.definitionLine === null
    ? `d${group.depth} ${group.kind} ${group.label}:${siteList(group.sites, group.file, cap)} [${group.basis}]`
    : `d${group.depth} ${group.kind} ${group.label}:${group.definitionLine} [${group.basis}; source ${siteList(group.sites, "", cap)}]`;
  const details = new Map<string, CallerSite[]>();
  for (const site of group.sites) {
    const key = site.detail.join("\n");
    details.set(key, [...(details.get(key) ?? []), site]);
  }
  const lines = [header];
  if (details.size === 1) {
    for (const line of group.sites[0]?.detail ?? []) lines.push(`  ${line}`);
    return lines;
  }
  for (const [, sites] of details) {
    const where = siteList(sites, group.file);
    for (const line of sites[0]?.detail ?? []) lines.push(`  ${where}: ${line}`);
  }
  return lines;
}

interface UnresolvedGroup {
  readonly depth: number;
  readonly kind: EdgeKind;
  readonly name: string;
  readonly basis: string;
  readonly detail: string[];
  readonly candidates: string | undefined;
  readonly sites: CallerSite[];
  edges: number;
}

function unresolvedBasis(edge: OsnovaEdge): string {
  const resolution = edge.evidence?.source === "syntax" ? edge.evidence.resolution : undefined;
  if (resolution?.status === "unresolved") {
    return `${resolution.reason}${resolution.external === undefined ? "" : ` (external:${resolution.external})`}`;
  }
  return resolution?.status ?? "unknown provenance";
}

function candidateLine(name: string, matches: NameMatches | undefined): string | undefined {
  if (matches === undefined || matches.total === 0) return undefined;
  const more = matches.total - matches.candidates.length;
  return `candidates for ${name} (${matches.total}, unverified): ${matches.candidates.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

function unresolvedGroups(items: readonly UnresolvedCallerEdge[]): UnresolvedGroup[] {
  const groups = new Map<string, UnresolvedGroup>();
  for (const { edge, depth, nameMatches } of items) {
    const basis = unresolvedBasis(edge);
    const detail = [...routeDetail(edge), ...(edge.evidence?.source === "syntax" && edge.evidence.resolution.status === "ambiguous"
      ? [`ambiguous candidates: ${edge.evidence.resolution.candidates.join(", ")}`]
      : [])];
    const candidates = candidateLine(edge.toName, nameMatches);
    const key = [depth, edge.kind, edge.toName, basis, detail.join("\n"), candidates ?? ""].join("\0");
    const group = groups.get(key) ?? { depth, kind: edge.kind, name: edge.toName, basis, detail, candidates, sites: [], edges: 0 };
    if (!group.sites.some((site) => site.file === edge.fromFile && site.line === edge.line)) {
      group.sites.push({ file: edge.fromFile, line: edge.line, detail: [] });
    }
    group.edges += 1;
    groups.set(key, group);
  }
  const sorted = [...groups.values()];
  for (const group of sorted) group.sites.sort(compareSites);
  sorted.sort((a, b) => compareText(a.name, b.name) || a.depth - b.depth || compareText(a.kind, b.kind)
    || compareText(a.basis, b.basis) || compareText(a.detail.join("\n"), b.detail.join("\n")) || compareSites(a.sites[0], b.sites[0]));
  return sorted;
}

function unresolvedGroupLines(groups: readonly UnresolvedGroup[], cap = Number.POSITIVE_INFINITY): string[] {
  const shownCandidates = new Set<string>();
  const lines: string[] = [];
  for (const group of groups) {
    if (group.candidates !== undefined && !shownCandidates.has(group.candidates)) {
      shownCandidates.add(group.candidates);
      lines.push(group.candidates);
    }
    lines.push(`d${group.depth} ${group.kind} ${group.name} ${siteList(group.sites, "", cap)} [${group.basis}]`);
    for (const line of group.detail) lines.push(`  ${line}`);
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
  const groups = callerGroups(result.hits).sort(comparePriority);
  const hoisted = hoistedVia(groups, Math.floor(maxCodeUnits / 4));
  const shownGroups = hoisted.length > 0 ? groups.map((group) => stripVia(group, hoisted)) : groups;
  const summary = groups.length > 0 ? [directorySummary(groups, Math.floor(maxCodeUnits / 4))] : [];
  const hoistedLines = hoisted.map((line) => `via (all): ${line.slice("via ".length)}`);
  const unresolvedBlocks = unresolvedGroups(result.unresolved);
  const footer = (shownEdges: number, shownUnresolved: number): string => `omitted: ${result.hits.length - shownEdges} of ${result.hits.length} confirmed edges; ${result.unresolved.length - shownUnresolved} of ${result.unresolved.length} unresolved evidence items. Use callersDetailed API for complete structured results.`;
  const targetSuffix = `: ${result.hits.length} indexed edges`;
  const reachLines = result.reach === undefined ? [] : [formatReach(result.reach)];
  const fixedUnits = [...base, ...reachLines, ...summary, ...hoistedLines, footer(0, 0)].join("\n").length + targetSuffix.length + 2;
  const target = `${result.target.kind} ${compactField(result.target.qualifiedName, Math.max(1, maxCodeUnits - fixedUnits - result.target.kind.length - 1))}${targetSuffix}`;
  const header = [base[0] ?? "", target, ...reachLines, base[1] ?? "", ...summary, ...hoistedLines];
  const unresolvedHeader = `unresolved evidence (${result.unresolved.length}); not confirmed relationships`;
  const folds = (tail: readonly CallerGroup[]): FoldLine[] => {
    const byFile = new Map<string, FoldLine>();
    for (const group of tail) {
      const key = `d${group.depth} ${group.kind} ${group.file}`;
      const fold = byFile.get(key) ?? { key, symbols: 0, edges: 0 };
      byFile.set(key, { key, symbols: fold.symbols + 1, edges: fold.edges + group.edges });
    }
    return [...byFile.values()];
  };
  const layout = (cap: number, shown: number, foldLines: readonly FoldLine[], unresolved: readonly UnresolvedGroup[]): { text: string; edges: number } => {
    const visible = shownGroups.slice(0, shown);
    const hidden = [...visible, ...unresolved].reduce((sum, group) => sum + Math.max(0, siteCount(group) - cap), 0);
    const foldedEdges = foldLines.reduce((sum, fold) => sum + fold.edges, 0);
    const edges = visible.reduce((sum, group) => sum + group.edges, 0) + foldedEdges;
    const capped: string[] = [];
    if (hidden > 0) capped.push(`${cap} line number${cap === 1 ? "" : "s"} per symbol; ${hidden} site${hidden === 1 ? "" : "s"} not listed`);
    if (foldLines.length > 0) capped.push(`${foldedEdges} edges folded into ${foldLines.length} file line${foldLines.length === 1 ? "" : "s"}`);
    const text = [
      ...header,
      ...visible.flatMap((group) => callerGroupLines(group, cap)),
      ...foldLines.map((fold) => `${fold.key}: +${fold.symbols} symbol${fold.symbols === 1 ? "" : "s"}, ${fold.edges} edge${fold.edges === 1 ? "" : "s"}`),
      ...(capped.length > 0 ? [`capped: ${capped.join("; ")}; request full output for every site.`] : []),
      ...(unresolved.length > 0 ? [unresolvedHeader, ...unresolvedGroupLines(unresolved, cap)] : []),
      footer(edges, unresolved.reduce((sum, group) => sum + group.edges, 0)),
    ].join("\n");
    return { text, edges };
  };
  const fits = (cap: number, shown: number, foldLines: readonly FoldLine[], unresolved: readonly UnresolvedGroup[]): boolean =>
    layout(cap, shown, foldLines, unresolved).text.length <= maxCodeUnits;
  const maxSites = Math.max(1, ...shownGroups.map(siteCount));
  let cap = 1;
  let shown = shownGroups.length;
  const selectedFolds: FoldLine[] = [];
  if (fits(maxSites, shown, [], [])) {
    cap = maxSites;
  } else if (fits(1, shown, [], [])) {
    let low = 1;
    let high = maxSites;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(middle, shown, [], [])) low = middle;
      else high = middle - 1;
    }
    cap = low;
  } else {
    shown = 0;
    while (shown < shownGroups.length && fits(1, shown + 1, folds(shownGroups.slice(shown + 1)), [])) shown += 1;
    for (const fold of folds(shownGroups.slice(shown))) {
      if (fits(1, shown, [...selectedFolds, fold], [])) selectedFolds.push(fold);
    }
  }
  const selectedUnresolved: UnresolvedGroup[] = [];
  for (const block of unresolvedBlocks) {
    if (fits(cap, shown, selectedFolds, [...selectedUnresolved, block])) selectedUnresolved.push(block);
  }
  return layout(cap, shown, selectedFolds, selectedUnresolved).text;
}

interface FoldLine {
  readonly key: string;
  readonly symbols: number;
  readonly edges: number;
}

function isTestFile(file: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//.test(file) || /[._](test|spec)\.[^/]+$/.test(file) || /(^|\/)test_[^/]+$/.test(file);
}

function comparePriority(a: CallerGroup, b: CallerGroup): number {
  return a.depth - b.depth || Number(isTestFile(a.file)) - Number(isTestFile(b.file)) || compareGroups(a, b);
}

function directorySummary(groups: readonly CallerGroup[], maxCodeUnits: number): string {
  const directories = new Map<string, { sites: number; files: Set<string>; allTest: boolean }>();
  for (const group of groups) {
    const slash = group.file.lastIndexOf("/");
    const directory = slash === -1 ? "./" : group.file.slice(0, slash + 1);
    const entry = directories.get(directory) ?? { sites: 0, files: new Set<string>(), allTest: true };
    entry.sites += siteCount(group);
    entry.files.add(group.file);
    entry.allTest &&= isTestFile(group.file);
    directories.set(directory, entry);
  }
  const ordered = [...directories].sort(([a, left], [b, right]) => Number(left.allTest) - Number(right.allTest) || compareText(a, b));
  const entries = ordered.map(([directory, { sites, files }]) => `${directory}: ${sites} site${sites === 1 ? "" : "s"} in ${files.size} file${files.size === 1 ? "" : "s"}`);
  const kept: string[] = [];
  for (const entry of entries) {
    const rest = entries.length - kept.length - 1;
    const line = `summary: ${[...kept, entry].join("; ")}${rest > 0 ? `; +${rest} directories` : ""}`;
    if (line.length > maxCodeUnits) break;
    kept.push(entry);
  }
  const rest = entries.length - kept.length;
  return `summary: ${kept.join("; ")}${rest > 0 ? `${kept.length > 0 ? "; " : ""}+${rest} directories` : ""}`;
}

function hoistedVia(groups: readonly CallerGroup[], maxCodeUnits: number): string[] {
  let shared: string | undefined;
  let carriers = 0;
  for (const group of groups) {
    const perSite = group.sites.map((site) => site.detail.filter((line) => line.startsWith("via ")).join("\n"));
    const present = perSite.filter((value) => value.length > 0);
    if (present.length === 0) continue;
    if (present.length !== perSite.length || new Set(present).size !== 1) return [];
    const value = present[0] ?? "";
    if (shared !== undefined && shared !== value) return [];
    shared = value;
    carriers += 1;
  }
  if (shared === undefined || carriers < 2 || shared.length > maxCodeUnits) return [];
  return shared.split("\n");
}

function stripVia(group: CallerGroup, hoisted: readonly string[]): CallerGroup {
  return { ...group, sites: group.sites.map((site) => ({ ...site, detail: site.detail.filter((line) => !hoisted.includes(line)) })) };
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
      lines.push(`  ${hotspot.qualifiedName} (in ${hotspot.inEdges} from ${hotspot.inFiles} files, out ${hotspot.outEdges}) ${hotspot.file}:${hotspot.line}`);
    }
  }
  return lines.join("\n");
}

export function formatTaskContext(result: TaskContextResult): string {
  const lines = [
    `osnova footing: ${result.task}, scope ${result.scope === "" ? "." : result.scope}, ${result.definitions.length} definitions, ${result.relationships.length} relationships, ${result.candidateTests.length} candidate tests`,
  ];
  if (result.definitions.length > 0) lines.push("definitions:");
  for (const definition of result.definitions) {
    const { symbol } = definition;
    lines.push(`- ${symbol.qualifiedName} ${symbol.kind} lines ${symbol.span.startLine}-${symbol.span.endLine}`);
    if (definition.reach !== undefined) lines.push(`  ${formatReach(definition.reach)}`);
    for (const line of definition.excerpt.split("\n")) lines.push(`  ${line}`);
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

export const impactReceiptDigits = 16;

const impactNoteText: Readonly<Record<string, string>> = {
  "indexed-graph-only": "",
  "base-snapshot-is-current-index": "base = current index, deletions invisible",
  "deleted-symbols-not-visible": "",
  "receipts-identify-indexed-content-not-disk-freshness": "receipts = indexed content, not disk or runtime",
  "rename-identity-is-not-proven": "renames unproven",
  "one-shortest-path-per-dependent": "one shortest path each",
  "provided-diff-ranges-not-verified-against-source": "diff ranges unverified",
  "index-diagnostics-present": "diagnostics present",
};

export function formatImpactDependent(dependent: ImpactResult["dependents"][number]): string {
  return `${dependent.snapshot} d${dependent.depth} ${dependent.symbol?.qualifiedName ?? dependent.file} [source ${dependent.receipt.hash.slice(0, impactReceiptDigits)}]`;
}

export function formatImpactFiles(result: ImpactResult): string[] {
  if (result.files.length === 0) return [];
  return [`files changed: ${result.files.length}; importers of changed files: ${result.omitted.fileImporters} (not listed; module-level edits attribute to no symbol)`];
}

export function formatImpactUncertainty(uncertainty: ImpactResult["uncertainty"]): string {
  const phrases = uncertainty.notes.map((note) => {
    const short = note.match(/^diff-short-by-(\d+)-context-lines-treated-as-unchanged$/);
    return short === null ? impactNoteText[note] ?? note : `diff ${short[1]} context lines short, treated unchanged`;
  }).filter((text) => text !== "");
  return [`uncertainty: ${uncertainty.unresolvedEdges} unresolved edges not listed; a missing dependent is not proof of absence`, ...phrases].join("; ");
}

export function formatImpact(result: ImpactResult): string {
  return [
    `osnova settle: ${result.changes.length} symbol changes; ${result.dependents.length} dependents; ${result.omitted.dependentFrontier} frontier items omitted`,
    ...result.changes.map((change) => `${change.kind}: ${change.before?.symbol.qualifiedName ?? "<new>"} -> ${change.after?.symbol.qualifiedName ?? "<deleted>"}`),
    ...formatImpactFiles(result),
    ...result.dependents.map(formatImpactDependent),
    formatImpactUncertainty(result.uncertainty),
  ].join("\n");
}

const percent = (share: number): string => `${(share * 100).toFixed(1)}%`;

export function formatCoverage(report: CoverageReport): string {
  const row = (item: LanguageCoverage): string =>
    `${item.language}: files ${item.files}, symbols ${item.symbols}, calls ${item.calls}, resolved ${item.resolved} (${percent(item.resolvedShare)}; ${percent(item.resolvedShareExcludingExternal)} of the ${item.calls - item.unresolvedImportCalls - item.unboundGlobalCalls} not going through an unresolved import or an unbound global), ambiguous ${item.ambiguous}, unresolved ${item.unresolved}, references ${item.references} (${item.referencesResolved} resolved), extends ${item.extends} (${item.extendsResolved} resolved), implements ${item.implements} (${item.implementsResolved} resolved), routes ${item.routes} (${item.routesResolved} resolved)`;
  const reasons = Object.entries(report.total.byReason).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  const lines = [
    `osnova coverage: ${report.total.resolved}/${report.total.calls} call sites resolved (${percent(report.total.resolvedShare)}); ${report.total.unresolvedImportCalls} call sites go through an import the index cannot resolve, ${report.total.unboundGlobalCalls} call a name with no binding in the file`,
    ...report.languages.map(row),
  ];
  // Stated on stdout, beside the percentages it qualifies: the same notice on stderr is lost the moment
  // the report is redirected to a file.
  const skipped = report.oversizedFiles;
  if (skipped.length > 0) {
    lines.push(
      `not indexed: ${skipped.length} ${skipped.length === 1 ? "file" : "files"} above the ${sizeCapText} size cap; ${skipped.length === 1 ? "its" : "their"} call sites are not counted above`,
      ...skipped.slice(0, 10).map((file) => `- ${file.path}: ${file.size} bytes`),
      ...(skipped.length > 10 ? [`- ${skipped.length - 10} more; coverage --json lists every one`] : []),
    );
  }
  const external = report.total.externalImportCalls;
  const detail = (reason: string, count: number): string => reason === "import-target-unresolved" && external > 0 ? ` (external ${external}, in-repo ${count - external})` : "";
  if (reasons.length > 0) lines.push("unresolved by reason:", ...reasons.map(([reason, count]) => `- ${reason}: ${count}${detail(reason, count)}`));
  const packages = Object.entries(report.total.byExternal).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).slice(0, 10);
  if (packages.length > 0) lines.push("external packages (top 10):", ...packages.map(([name, count]) => `- ${name}: ${count}`));
  lines.push(`limitations: ${report.limitations.join(", ")}`);
  return lines.join("\n");
}

const doctorTiers: ReadonlyArray<{ readonly extraction: LanguageCapability["extraction"]; readonly resolution: LanguageCapability["resolution"]; readonly label: string }> = [
  { extraction: "syntax", resolution: "binding-and-receiver-hints", label: "syntax, binding and receiver hints" },
  { extraction: "syntax", resolution: "name-heuristics", label: "syntax, name heuristics" },
  { extraction: "tags", resolution: "binding-and-receiver-hints", label: "tags query, binding and receiver hints" },
  { extraction: "tags", resolution: "name-heuristics", label: "tags query, name heuristics" },
];

// doctor is what a new user runs when nothing works, so its default form is read by a person. The
// JSON form keeps every field, including the per-language limitation text this summary leaves out.
export function formatDoctor(report: DoctorReport): string {
  const statusCount = (status: DiagnosticCheck["status"]): number => report.checks.filter((check) => check.status === status).length;
  const counts = (["ok", "warning", "error"] as const).map((status) => [status, statusCount(status)] as const).filter(([, count]) => count > 0);
  const lines = [
    `osnova doctor: ${report.ok ? "ok" : "failed"}, read-only`,
    `checks: ${counts.length === 0 ? "none" : counts.map(([status, count]) => `${count} ${status}`).join(", ")}`,
    ...report.checks.filter((check) => check.status !== "ok").map((check) => `  ${check.status} ${check.id}: ${check.message}`),
    `language support, ${report.capabilities.length} languages:`,
  ];
  for (const tier of doctorTiers) {
    const members = report.capabilities.filter((item) => item.extraction === tier.extraction && item.resolution === tier.resolution);
    if (members.length === 0) continue;
    const names = members.map((item) => item.status === "ok" ? item.language : `${item.language} (grammar failed to load)`);
    lines.push(`  ${tier.label} (${members.length}): ${names.join(", ")}`);
  }
  lines.push(
    "  no language has type inference: relationships are structural, not a type checker's",
    ...(report.fallback.length > 0 ? [`other files: ${report.fallback}`] : []),
    "grammar checks parse a short synthetic snippet: they show each packaged grammar loads, not that every real file parses",
    "per-language limitations: osnova doctor --json",
  );
  return lines.join("\n");
}

export function formatPlumb(result: PlumbResult, symbol?: string): string {
  const name = result.target.qualifiedName ?? symbol ?? "<unknown>";
  const c = result.counts;
  const lines = [`osnova plumb: ${name}, ${c.confirmed} confirmed, ${c.nameOnly} name-only, ${c.noCall} no-call, ${c.notIndexed} not-indexed, ${c.missing} missing`];
  if (result.claims.length > 0) lines.push("claims:");
  for (const item of result.claims) {
    const other = item.edge === undefined ? "" : ` -> ${result.direction === "in" ? item.edge.fromSymbol || item.edge.fromFile : item.edge.toSymbol ?? item.edge.toName}`;
    const matches = item.nameMatches === undefined || item.nameMatches.total === 0 ? "" : ` (${item.nameMatches.total} same-name symbols: ${item.nameMatches.candidates.join(", ")}${item.nameMatches.total > item.nameMatches.candidates.length ? " and more" : ""})`;
    lines.push(`${item.verdict} ${item.claim.file}:${item.claim.line}${other}${matches}`);
  }
  if (result.missing.length > 0) lines.push("missing:");
  for (const edge of result.missing) lines.push(`${edge.fromFile}:${edge.line} ${result.direction === "in" ? edge.fromSymbol || edge.fromFile : edge.toSymbol ?? edge.toName}`);
  lines.push(`limitations: ${result.limitations.join(", ")}`);
  return lines.join("\n");
}

const testsNotice = "No indexed test is not proof of no test: unindexed files, dynamic calls and name-heuristic references are invisible; a listed test references the symbol, it does not prove coverage.";

function testSiteText(file: string, sites: readonly TestSite[], omitted: number): string {
  const groups = new Map<string, number[]>();
  for (const site of sites) {
    const key = `${site.kind} ${site.method}`;
    groups.set(key, [...(groups.get(key) ?? []), site.line]);
  }
  const text = [...groups].map(([key, lines]) => `${file}:${lines.join(",")} ${key}`).join("; ");
  return omitted > 0 ? `${text}; +${omitted} more sites` : text;
}

const testTierCounts = (resolved: number, importOnly: number, includeImportOnly: boolean): string =>
  `${resolved} test files with a resolved edge; ${includeImportOnly ? `${importOnly} import the file only` : "import-only files excluded"}`;

export function formatTestsFor(result: TestsForResult): string {
  const isResolved = (test: TestFileEvidence): boolean => test.basis === "test-path-and-resolved-edge";
  const totalResolved = result.symbols.reduce((sum, item) => sum + item.tests.filter(isResolved).length, 0);
  const totalImportOnly = result.symbols.reduce((sum, item) => sum + item.tests.length, 0) - totalResolved;
  const lines = [`osnova tests: ${result.symbols.length} symbols; ${testTierCounts(totalResolved, totalImportOnly, result.includeImportOnly)}`];
  for (const item of result.symbols) {
    const { symbol } = item;
    const resolved = item.tests.filter(isResolved);
    const importOnly = item.tests.filter((test) => !isResolved(test));
    lines.push(`${symbol.kind} ${symbol.qualifiedName} ${symbol.file}:${symbol.span.startLine}: ${testTierCounts(resolved.length, importOnly.length, result.includeImportOnly)}${item.omittedTests > 0 ? `; ${item.omittedTests} omitted` : ""}`);
    if (resolved.length === 0) lines.push(`no indexed test file has a resolved call or reference edge to ${symbol.qualifiedName}`);
    else lines.push("resolved edge (calls or references the symbol):");
    for (const test of resolved) lines.push(`- ${test.file} (resolved edge): ${testSiteText(test.file, test.sites, test.omittedSites)}`);
    if (importOnly.length === 0) continue;
    lines.push("imports the file only (no indexed call or reference to the symbol):");
    for (const test of importOnly) lines.push(`- ${test.file} (imports the file only): ${testSiteText(test.file, test.sites, test.omittedSites)}`);
  }
  if (result.unknownSymbols.length > 0) lines.push(`unknown symbols: ${result.unknownSymbols.join(", ")}`);
  lines.push(testsNotice, `limitations: ${result.limitations.join(", ")}`);
  return lines.join("\n");
}

export function formatSymbolsUnderTest(result: SymbolsUnderTestResult): string {
  const lines = [`osnova tests: ${result.file}${result.isTestPath ? "" : " (not a test path)"}: ${result.symbols.length} symbols under test${result.omittedSymbols > 0 ? `, ${result.omittedSymbols} omitted` : ""}, ${result.imports.length} imported files, ${result.unresolvedEdges} unresolved edges not listed`];
  for (const item of result.symbols) {
    const { symbol } = item;
    lines.push(`- ${symbol.kind} ${symbol.qualifiedName} ${symbol.file}:${symbol.span.startLine}: ${testSiteText(result.file, item.sites, item.omittedSites)}`);
  }
  if (result.imports.length > 0) lines.push("imports:");
  for (const item of result.imports) lines.push(`- ${item.file} at ${item.lines.map((line) => `${result.file}:${line}`).join(", ")}`);
  lines.push(testsNotice, `limitations: ${result.limitations.join(", ")}`);
  return lines.join("\n");
}

export function formatUnreferenced(result: UnreferencedResult): string {
  const listed = result.candidates.length;
  const lines = [`osnova unreferenced: scope ${result.scope === "" ? "." : result.scope}, kinds ${result.kinds.join(",")}, ${listed} candidates listed of ${listed + result.omitted}, ${result.exportedNotListed} exported not listed, ${result.shadowedNotListed} shadowed not listed, ${result.examined} symbols examined`];
  for (const candidate of result.candidates) {
    const symbol = candidate.symbol;
    const mentions = candidate.mentions === null ? "text mentions skipped (corpus over cap)" : `${candidate.mentions} text mentions in non-test files`;
    const noLeads = candidate.unresolvedSameNameSites === 0 && candidate.testSites === 0 && candidate.mentions === 0 ? "; no leads" : "";
    lines.push(`- ${symbol.kind} ${symbol.qualifiedName} ${symbol.file}:${symbol.span.startLine}${candidate.exported ? " (exported)" : ""}: ${candidate.unresolvedSameNameSites} unresolved same-name sites, ${candidate.testSites} test sites, ${mentions}${noLeads}`);
  }
  lines.push(`${result.withoutLeads} of ${listed} listed candidates have no lead at all (no unresolved same-name site, no test site, no text mention); a lead is a place to check by hand, not a caller.`);
  const entries = result.entryPoints;
  lines.push(
    `entry points excluded: main ${entries.main}, default export ${entries["default-export"]}, index file ${entries["index-file"]}, package.json bin ${entries["package-bin"]}, test file ${entries["test-file"]}, constructor ${entries.constructor}, python dunder ${entries["python-dunder"]}`,
    entryPointRuleText,
    result.exportedNotListed > 0 ? "exported symbols are entry points for external consumers and are listed only with includeExported." : "",
    result.shadowedNotListed > 0 ? "shadowed symbols (a name the file declares in more than one scope) are never listed: the index records no edge to them, so their absence from the graph is not evidence." : "",
    unreferencedNotice,
    `limitations: ${result.limitations.join(", ")}`,
  );
  return lines.filter((line) => line.length > 0).join("\n");
}

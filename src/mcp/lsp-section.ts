import type { LspReferencesAnswer } from "../enrichment/session.js";
import type { CallersDetailedResult, OsnovaIndex, OsnovaSymbol } from "../types.js";

export const maximumLspSectionCodeUnits = 1_024;
const header = "language server (textDocument/references";

type Found = Extract<CallersDetailedResult, { status: "found" }>;

// A reference written as a declaration of the name (an overload signature, `def`, `class`, `const`...), read from the
// text before the name on its line. Declarations without a keyword, such as a method signature, are not recognised.
const declarationKeyword = /(?:^|[^\p{L}\p{N}_$])(?:function\*?|def|class|interface|type|enum|struct|trait|fn|func|const|let|var|val)\s+$/u;
function memberCall(index: OsnovaIndex, file: string, line: number, character: number): boolean {
  const text = index.files.get(file)?.text.split(/\r\n|\r|\n/)[line];
  return text !== undefined && /(?:\.|::)\s*$/.test(text.slice(0, character));
}

function declaredAt(index: OsnovaIndex, file: string, line: number, character: number): boolean {
  const text = index.files.get(file)?.text.split(/\r\n|\r|\n/)[line];
  return text !== undefined && declarationKeyword.test(text.slice(0, character));
}

// Nearest enclosing definition, for a location the section lists.
function enclosing(index: OsnovaIndex, file: string, line: number): OsnovaSymbol | undefined {
  let best: OsnovaSymbol | undefined;
  for (const symbol of index.files.get(file)?.symbols ?? []) {
    if (symbol.span.startLine > line || symbol.span.endLine < line) continue;
    if (best === undefined || symbol.span.endLine - symbol.span.startLine < best.span.endLine - best.span.startLine) best = symbol;
  }
  return best;
}

/**
 * The server's references to the target, sorted against the graph answer above it: the declaration, callers the graph
 * already resolved, unresolved leads the server confirms, and locations the graph does not hold. Server locations stay
 * in this section and never become graph edges. A call line may sit one line from the identifier the server reports.
 */
export function formatLspReferences(index: OsnovaIndex, result: Found, answer: LspReferencesAnswer, budget = maximumLspSectionCodeUnits): string {
  if (answer.status === "unavailable") return `${header}): unavailable (${answer.code})`;
  // A location on a line the graph lists matches that line, however many calls the line holds. A call split
  // across two lines may instead match a neighbouring listed line, but only a line no location matched exactly, and
  // each such line once, so an import next to a resolved call is not mistaken for that call.
  const resolved = new Set(result.hits.filter((hit) => hit.depth === 1 && hit.file !== null && hit.line !== null).map((hit) => `${hit.file}:${hit.line}`));
  const leads = new Set(result.unresolved.filter((lead) => lead.depth === 1).map((lead) => `${lead.edge.fromFile}:${lead.edge.line}`));
  const matched = new Set<string>();
  let declaration = 0;
  let already = 0;
  const confirmedAt: { file: string; line: number }[] = [];
  const pending: { file: string; line: number }[] = [];
  for (const location of answer.locations) {
    if ((location.file === result.target.file && location.range.start.line === answer.queried.line && location.range.start.character === answer.queried.character) || declaredAt(index, location.file, location.range.start.line, location.range.start.character)) { declaration += 1; continue; }
    const line = location.range.start.line + 1;
    const key = `${location.file}:${line}`;
    // The graph stores no column, so on a line holding both a resolved call and an unresolved lead, a location written
    // after `.` or `::` is taken as the member call the lead stands for.
    const lead = leads.has(key) && (!resolved.has(key) || memberCall(index, location.file, location.range.start.line, location.range.start.character));
    if (resolved.has(key) && !lead) { already += 1; matched.add(key); }
    else if (lead) { confirmedAt.push({ file: location.file, line }); matched.add(key); }
    else pending.push({ file: location.file, line });
  }
  const outsideAt: { file: string; line: number }[] = [];
  for (const at of pending) {
    const neighbour = (set: ReadonlySet<string>): string | undefined => [`${at.file}:${at.line - 1}`, `${at.file}:${at.line + 1}`].find((key) => set.has(key) && !matched.has(key));
    const near = neighbour(resolved);
    const nearLead = near === undefined ? neighbour(leads) : undefined;
    if (near !== undefined) { already += 1; matched.add(near); }
    else if (nearLead !== undefined) { confirmedAt.push(at); matched.add(nearLead); }
    else outsideAt.push(at);
  }
  // One entry per line, with the number of locations when a line holds more than one.
  const entries = (places: readonly { file: string; line: number }[]): string[] => {
    const lines = new Map<string, { file: string; line: number; count: number }>();
    for (const at of places) { const key = `${at.file}:${at.line}`; const seen = lines.get(key); if (seen) seen.count += 1; else lines.set(key, { ...at, count: 1 }); }
    return [...lines.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)).map((at) => {
      const where = enclosing(index, at.file, at.line);
      return `    ${at.file}:${at.line} ${where === undefined ? "(top level)" : `in ${where.name}`}${at.count > 1 ? ` (${at.count} on this line)` : ""}`;
    });
  };
  const confirmed = entries(confirmedAt);
  const outside = entries(outsideAt);
  const notes = [
    ...(answer.status === "partial" ? ["the server's list was cut or held locations outside the index"] : []),
    ...(answer.filesGiven < answer.filesEligible ? [`the server was given ${answer.filesGiven} of ${answer.filesEligible} files`] : []),
    ...(answer.loading ? ["the server was still loading its projects, so its list may be incomplete"] : []),
  ];
  const partial = notes.length > 0 ? ` (${notes.join("; ")})` : "";
  const lines = [`${header}, not syntax edges): ${answer.locations.length} locations: declaration ${declaration}, resolved above ${already}, confirmed unresolved leads ${confirmedAt.length}, not in the graph ${outsideAt.length}${partial}`];
  const total = confirmed.length + outside.length;
  let shown = 0;
  let used = lines[0]!.length;
  const reserve = `\n  +${total} more lines not shown`.length;
  const add = (title: string, entries: readonly string[]): void => {
    if (entries.length === 0) return;
    const heading = `  ${title} (${entries.length} ${entries.length === 1 ? "line" : "lines"}):`;
    if (used + 1 + heading.length + reserve > budget) return;
    const start = lines.length;
    lines.push(heading); used += 1 + heading.length;
    let added = 0;
    for (const entry of entries) {
      if (used + 1 + entry.length + reserve > budget) break;
      lines.push(entry); used += 1 + entry.length; added += 1;
    }
    if (added === 0) { lines.splice(start); used -= 1 + heading.length; }
    shown += added;
  };
  add("confirmed unresolved leads", confirmed);
  add("not in the graph", outside);
  if (shown < total) lines.push(`  +${total - shown} more lines not shown`);
  return lines.join("\n");
}

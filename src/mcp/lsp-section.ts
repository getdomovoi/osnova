import type { LspReferencesAnswer } from "../enrichment/session.js";
import type { LspLocation } from "../enrichment/types.js";
import type { PlumbResult, PlumbVerdict } from "../query/plumb.js";
import type { CallersDetailedResult, OsnovaIndex, OsnovaSymbol } from "../types.js";

export const maximumLspSectionCodeUnits = 1_024;
const header = "language server (textDocument/references";

type Found = Extract<CallersDetailedResult, { status: "found" }>;
type Answered = Exclude<LspReferencesAnswer, { status: "unavailable" }>;
interface At { readonly file: string; readonly line: number }
interface Listed extends At { readonly before?: string | undefined; readonly after?: string | undefined }

const unavailable = (code: string): string => `${header}): unavailable (${code})`;

// A reference written as a declaration of the name (an overload signature, `def`, `class`, `const`...), read from the
// text before the name on its line. Declarations without a keyword, such as a method signature, are not recognised.
const declarationKeyword = /(?:^|[^\p{L}\p{N}_$])(?:function\*?|def|class|interface|type|enum|struct|trait|fn|func|const|let|var|val)\s+$/u;
function declaredAt(index: OsnovaIndex, file: string, line: number, character: number): boolean {
  const text = index.files.get(file)?.text.split(/\r\n|\r|\n/)[line];
  return text !== undefined && declarationKeyword.test(text.slice(0, character));
}

// The queried position, and a location written as a declaration of the name, count as declarations.
function isDeclaration(index: OsnovaIndex, target: OsnovaSymbol, answer: Answered, location: LspLocation): boolean {
  return (location.file === target.file && location.range.start.line === answer.queried.line && location.range.start.character === answer.queried.character)
    || declaredAt(index, location.file, location.range.start.line, location.range.start.character);
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

const compareAt = (a: At, b: At): number => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);

// One entry per line, with the number of locations when a line holds more than one.
function entries(index: OsnovaIndex, places: readonly Listed[]): string[] {
  const lines = new Map<string, Listed & { count: number }>();
  for (const at of places) { const key = `${at.file}:${at.line}`; const seen = lines.get(key); if (seen) seen.count += 1; else lines.set(key, { ...at, count: 1 }); }
  return [...lines.values()].sort(compareAt).map((at) => {
    const where = enclosing(index, at.file, at.line);
    return `    ${at.file}:${at.line}${at.before === undefined ? "" : ` ${at.before}`} ${where === undefined ? "(top level)" : `in ${where.name}`}${at.count > 1 ? ` (${at.count} on this line)` : ""}${at.after ?? ""}`;
  });
}

function notes(answer: Answered): string {
  const found = [
    ...(answer.status === "partial" ? ["the server's list was cut or held locations outside the index"] : []),
    ...(answer.filesGiven < answer.filesEligible ? [`the server was given ${answer.filesGiven} of ${answer.filesEligible} files`] : []),
    ...(answer.loading ? ["the server was still loading its projects, so its list may be incomplete"] : []),
  ];
  return found.length > 0 ? ` (${found.join("; ")})` : "";
}

// Adds each titled group of entries after the first line while the section fits its budget, and ends with an exact
// count of the entries it left out.
function bounded(first: string, groups: readonly { title: string; entries: readonly string[] }[], budget: number): string {
  const lines = [first];
  const total = groups.reduce((sum, group) => sum + group.entries.length, 0);
  let shown = 0;
  let used = first.length;
  const reserve = `\n  +${total} more lines not shown`.length;
  for (const { title, entries } of groups) {
    if (entries.length === 0) continue;
    const heading = `  ${title} (${entries.length} ${entries.length === 1 ? "line" : "lines"}):`;
    if (used + 1 + heading.length + reserve > budget) continue;
    const start = lines.length;
    lines.push(heading); used += 1 + heading.length;
    let added = 0;
    for (const entry of entries) {
      if (used + 1 + entry.length + reserve > budget) break;
      lines.push(entry); used += 1 + entry.length; added += 1;
    }
    if (added === 0) { lines.splice(start); used -= 1 + heading.length; }
    shown += added;
  }
  if (shown < total) lines.push(`  +${total - shown} more lines not shown`);
  return lines.join("\n");
}

// Places each location on the first tier holding its line. A location on a line a tier lists matches that line,
// however many calls the line holds. A call split across two lines may instead match a neighbouring listed line, but
// only a line no location matched exactly, and each such line once, so an import next to a listed call is not
// mistaken for that call. Tiers are tried in order, exactly first and then by neighbour.
function place(locations: readonly At[], tiers: readonly ReadonlySet<string>[]): { tier: number | undefined; key: string | undefined; at: At }[] {
  const matched = new Set<string>();
  const placed: { tier: number | undefined; key: string | undefined; at: At }[] = [];
  const pending: At[] = [];
  for (const at of locations) {
    const key = `${at.file}:${at.line}`;
    const tier = tiers.findIndex((set) => set.has(key));
    if (tier < 0) { pending.push(at); continue; }
    placed.push({ tier, key, at }); matched.add(key);
  }
  for (const at of pending) {
    let found: { tier: number; key: string } | undefined;
    for (const [tier, set] of tiers.entries()) {
      const key = [`${at.file}:${at.line - 1}`, `${at.file}:${at.line + 1}`].find((near) => set.has(near) && !matched.has(near));
      if (key !== undefined) { found = { tier, key }; break; }
    }
    if (found !== undefined) matched.add(found.key);
    placed.push({ tier: found?.tier, key: found?.key, at });
  }
  return placed;
}

// Non-declaration locations as one-based lines, and the number of declarations among them.
function sites(index: OsnovaIndex, target: OsnovaSymbol, answer: Answered): { declaration: number; at: At[] } {
  let declaration = 0;
  const at: At[] = [];
  for (const location of answer.locations) {
    if (isDeclaration(index, target, answer, location)) declaration += 1;
    else at.push({ file: location.file, line: location.range.start.line + 1 });
  }
  return { declaration, at };
}

/**
 * The server's references to the target, sorted against the graph answer above it: the declaration, callers the graph
 * already resolved, unresolved leads the server confirms, and locations the graph does not hold. Server locations stay
 * in this section and never become graph edges. A call line may sit one line from the identifier the server reports.
 */
export function formatLspReferences(index: OsnovaIndex, result: Found, answer: LspReferencesAnswer, budget = maximumLspSectionCodeUnits): string {
  if (answer.status === "unavailable") return unavailable(answer.code);
  const resolved = new Set(result.hits.filter((hit) => hit.depth === 1 && hit.file !== null && hit.line !== null).map((hit) => `${hit.file}:${hit.line}`));
  const leads = new Set(result.unresolved.filter((lead) => lead.depth === 1).map((lead) => `${lead.edge.fromFile}:${lead.edge.line}`));
  const { declaration, at } = sites(index, result.target, answer);
  // The graph stores no column, so a line holding both a resolved call and an unresolved lead confirms nothing:
  // its locations count as resolved above.
  const placed = place(at, [resolved, leads]);
  const already = placed.filter((item) => item.tier === 0).length;
  const confirmedAt = placed.filter((item) => item.tier === 1).map((item) => item.at);
  const outsideAt = placed.filter((item) => item.tier === undefined).map((item) => item.at);
  const first = `${header}, not syntax edges): ${answer.locations.length} locations: declaration ${declaration}, resolved above ${already}, confirmed unresolved leads ${confirmedAt.length}, not in the graph ${outsideAt.length}${notes(answer)}`;
  return bounded(first, [
    { title: "confirmed unresolved leads", entries: entries(index, confirmedAt) },
    { title: "not in the graph", entries: entries(index, outsideAt) },
  ], budget);
}

/**
 * The server's references to a plumb target, sorted against the claim and the graph's missing list above: claims the
 * server confirms (and the graph verdict each one got), sites the graph already lists as missing, and sites the claim
 * left out that the graph does not list. The graph verdicts above are unchanged; server locations never become edges.
 */
export function formatLspPlumb(index: OsnovaIndex, result: PlumbResult, answer: LspReferencesAnswer, budget = maximumLspSectionCodeUnits): string {
  if (answer.status === "unavailable") return unavailable(answer.code);
  const claimed = new Set(result.claims.map((item) => `${item.claim.file}:${item.claim.line}`));
  const missing = new Set(result.missing.map((edge) => `${edge.fromFile}:${edge.line}`));
  const { declaration, at } = sites(index, result.target, answer);
  const placed = place(at, [claimed, missing]);
  const confirmedKeys = new Set(placed.filter((item) => item.tier === 0).map((item) => item.key));
  const confirmed = result.claims.filter((item) => confirmedKeys.has(`${item.claim.file}:${item.claim.line}`));
  const tally = (verdict: PlumbVerdict): number => confirmed.filter((item) => item.verdict === verdict).length;
  const sameNameCall = (spot: At): boolean => index.edgesForFile(spot.file).some((edge) => edge.kind === "calls" && edge.fromFile === spot.file && edge.line === spot.line && edge.toName === result.target.name);
  const onClaims = placed.filter((item) => item.tier === 0).length;
  const onMissing = placed.filter((item) => item.tier === 1).length;
  const elsewhere = placed.filter((item) => item.tier === undefined).map((item) => item.at);
  const first = `${header}, not syntax edges): ${answer.locations.length} locations: declaration ${declaration}, on claimed sites ${onClaims}, on missing sites above ${onMissing}, elsewhere ${elsewhere.length}${notes(answer)}; the server confirms ${confirmed.length} of ${result.claims.length} claims (graph confirmed ${tally("confirmed")}, name-only ${tally("name-only")}, no-call ${tally("no-call")}, not-indexed ${tally("not-indexed")})`;
  return bounded(first, [
    { title: "claims the server confirms and the graph does not", entries: entries(index, confirmed.filter((item) => item.verdict !== "confirmed").map((item) => ({ ...item.claim, before: item.verdict }))) },
    { title: "left out of the claim and not missing above", entries: entries(index, elsewhere.map((spot) => (sameNameCall(spot) ? { ...spot, after: " (graph: name-only)" } : spot))) },
  ], budget);
}

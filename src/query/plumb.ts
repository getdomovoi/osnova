import type { NameMatches, OsnovaEdge, OsnovaIndex, OsnovaSymbol } from "../types.js";
import { callersDetailed, nameMatches } from "./callers.js";
import { compareText } from "./impact.js";
import { validRelativePath } from "../index/workspace.js";

export interface PlumbClaim { readonly file: string; readonly line: number; }
export type PlumbVerdict = "confirmed" | "name-only" | "no-call" | "not-indexed";
export interface PlumbClaimResult { readonly claim: PlumbClaim; readonly verdict: PlumbVerdict; readonly edge?: OsnovaEdge | undefined; readonly nameMatches?: NameMatches | undefined; }
export interface PlumbOptions { readonly direction?: "in" | "out" | undefined; readonly depth?: number | undefined; }
export interface PlumbResult {
  readonly target: OsnovaSymbol;
  readonly direction: "in" | "out";
  readonly depth: number;
  readonly claims: readonly PlumbClaimResult[];
  readonly missing: readonly OsnovaEdge[];
  readonly counts: { readonly confirmed: number; readonly nameOnly: number; readonly noCall: number; readonly notIndexed: number; readonly missing: number };
  readonly limitations: readonly string[];
}

const limitations = ["confirmed-means-indexed-resolved-edge-not-runtime-proof", "name-only-is-a-heuristic-match", "missing-covers-indexed-resolved-edges-only", "call-edges-only"] as const;

export function parseClaims(texts: readonly string[]): PlumbClaim[] {
  const seen = new Set<string>();
  const claims: PlumbClaim[] = [];
  for (const text of texts) {
    const match = /^(.+):(\d+)$/.exec(text.trim());
    const line = match === null ? NaN : Number(match[2]);
    if (match === null || !Number.isSafeInteger(line) || line < 1 || match[1]!.length === 0) throw new Error(`osnova plumb: invalid claim ${JSON.stringify(text)}; use path:line`);
    const file = match[1]!.replace(/^\.\//, "");
    if (!validRelativePath(file)) throw new Error(`osnova plumb: invalid claim ${JSON.stringify(text)}; use a repository-relative path:line`);
    const key = `${file}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push({ file, line });
  }
  return claims;
}

const siteOf = (edge: OsnovaEdge, direction: "in" | "out"): { file: string; line: number } =>
  direction === "in" ? { file: edge.fromFile, line: edge.line } : { file: edge.fromFile, line: edge.line };

export function plumb(index: OsnovaIndex, symbol: string, claims: readonly PlumbClaim[], options: PlumbOptions = {}): PlumbResult {
  const direction = options.direction ?? "in";
  const depth = options.depth ?? 1;
  const detailed = callersDetailed(index, symbol, { direction, depth });
  const unique = parseClaims(claims.map((claim) => `${claim.file}:${claim.line}`));
  if (detailed.status === "ambiguous") {
    throw new Error(`osnova plumb: ${JSON.stringify(symbol)} matches ${detailed.candidates.length} symbols; choose one of: ${detailed.candidates.map((candidate) => candidate.qualifiedName).join(", ")}`);
  }
  // Walk resolved call edges only, so a reference or import edge never carries a claim to the next depth.
  const resolvedBySite = new Map<string, OsnovaEdge>();
  const visited = new Set<string>([detailed.target.qualifiedName]);
  let frontier = [detailed.target.qualifiedName];
  for (let level = 0; level < depth && frontier.length > 0; level++) {
    const next: string[] = [];
    for (const node of frontier) {
      const edges = direction === "in" ? index.incoming(node) : index.outgoing(node);
      for (const edge of edges) {
        if (edge.kind !== "calls" || edge.evidence?.source !== "syntax" || edge.evidence.resolution.status !== "resolved") continue;
        const site = siteOf(edge, direction);
        resolvedBySite.set(`${site.file}:${site.line}`, edge);
        const beyond = direction === "in" ? edge.fromSymbol : edge.toSymbol;
        if (beyond !== undefined && beyond.length > 0 && !visited.has(beyond)) { visited.add(beyond); next.push(beyond); }
      }
    }
    frontier = next.sort(compareText);
  }
  const target = detailed.target;
  const callsByFile = new Map<string, OsnovaEdge[]>();
  for (const edge of index.edges) {
    if (edge.kind !== "calls") continue;
    const list = callsByFile.get(edge.fromFile);
    if (list === undefined) callsByFile.set(edge.fromFile, [edge]); else list.push(edge);
  }
  const results: PlumbClaimResult[] = unique.map((claim) => {
    const key = `${claim.file}:${claim.line}`;
    const confirmed = resolvedBySite.get(key);
    if (confirmed !== undefined) return { claim, verdict: "confirmed", edge: confirmed };
    if (!index.files.has(claim.file)) return { claim, verdict: "not-indexed" };
    const nameMatch = (callsByFile.get(claim.file) ?? []).find((edge) => edge.line === claim.line &&
      (direction === "in" ? edge.toName === target.name : edge.fromSymbol === target.qualifiedName));
    return nameMatch === undefined ? { claim, verdict: "no-call" } : { claim, verdict: "name-only", edge: nameMatch, nameMatches: nameMatches(index, nameMatch) };
  });
  const claimed = new Set(unique.map((claim) => `${claim.file}:${claim.line}`));
  const missing = [...resolvedBySite.entries()].filter(([key]) => !claimed.has(key)).map(([, edge]) => edge)
    .sort((a, b) => compareText(a.fromFile, b.fromFile) || a.line - b.line);
  const count = (verdict: PlumbVerdict): number => results.filter((item) => item.verdict === verdict).length;
  return { target, direction, depth, claims: results, missing,
    counts: { confirmed: count("confirmed"), nameOnly: count("name-only"), noCall: count("no-call"), notIndexed: count("not-indexed"), missing: missing.length }, limitations };
}

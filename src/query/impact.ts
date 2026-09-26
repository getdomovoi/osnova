import path from "node:path";
import type { FileCard, OsnovaEdge, OsnovaIndex, OsnovaSymbol } from "../types.js";
import { knownIndexGeneration, rememberIndexGeneration } from "../index/generation.js";
import { serializeArtifact } from "../index/serialize.js";

export interface IndexReceipt {
  readonly generation: string;
  readonly basis: "indexed-content-sha256";
  readonly files: number;
  readonly diagnostics: number;
}

export interface SourceReceipt {
  readonly generation: string;
  readonly file: string;
  readonly hash: string;
}

export interface DefinitionEvidence {
  readonly symbol: OsnovaSymbol;
  readonly receipt: SourceReceipt;
}

export interface RelationshipEvidence {
  readonly edge: OsnovaEdge;
  readonly source: SourceReceipt;
  readonly target: SourceReceipt;
  readonly viaSources: readonly SourceReceipt[];
  readonly uncertainty: readonly string[];
}

export interface SymbolChange {
  readonly kind: "added" | "changed" | "deleted" | "renamed";
  readonly basis: "indexed-span" | "diff-range" | "identical-file-hash" | "diff-rename" | "same-position";
  readonly before: DefinitionEvidence | null;
  readonly after: DefinitionEvidence | null;
  readonly uncertainty: readonly string[];
}

export interface ImpactDependent {
  readonly snapshot: "base" | "current";
  readonly symbol: OsnovaSymbol | null;
  readonly file: string;
  readonly receipt: SourceReceipt;
  readonly depth: number;
  readonly path: readonly RelationshipEvidence[];
}

export interface ImpactOptions {
  readonly diff?: string | undefined;
  readonly maxDepth?: number | undefined;
  readonly diffPathPrefix?: string | undefined;
}

export interface ImpactResult {
  readonly base: IndexReceipt;
  readonly current: IndexReceipt;
  readonly changes: readonly SymbolChange[];
  readonly files: readonly { before: SourceReceipt | null; after: SourceReceipt | null }[];
  readonly dependents: readonly ImpactDependent[];
  readonly omitted: { readonly dependentFrontier: number; readonly fileImporters: number };
  readonly uncertainty: { readonly unresolvedEdges: number; readonly notes: readonly string[] };
}

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const receipts = new WeakMap<OsnovaIndex, IndexReceipt>();

export function indexReceipt(index: OsnovaIndex): IndexReceipt {
  const memoized = receipts.get(index);
  if (memoized !== undefined) return memoized;
  const generation = knownIndexGeneration(index) ?? rememberIndexGeneration(index, serializeArtifact(index));
  const receipt: IndexReceipt = { generation, basis: "indexed-content-sha256", files: index.files.size, diagnostics: (index.diagnostics ?? []).length };
  receipts.set(index, receipt);
  return receipt;
}

export function sourceReceipt(index: OsnovaIndex, file: string, receipt: IndexReceipt): SourceReceipt {
  const card = index.files.get(file);
  if (card === undefined) throw new Error(`osnova: source not indexed: ${file}`);
  return { generation: receipt.generation, file, hash: card.hash };
}

export function isReliableEdge(edge: OsnovaEdge): boolean {
  const evidence = edge.evidence;
  return evidence?.source === "syntax" && evidence.resolution.status === "resolved" &&
    !["same-file-name", "imported-file-name", "unique-name", "receiver-hint"].includes(evidence.resolution.method);
}

export function relationshipEvidence(index: OsnovaIndex, edge: OsnovaEdge, receipt: IndexReceipt): RelationshipEvidence | null {
  const targetFile = edge.toSymbol === undefined ? edge.toFile : index.symbols.get(edge.toSymbol)?.file ?? edge.toFile;
  if (targetFile === undefined || !index.files.has(targetFile) || !index.files.has(edge.fromFile)) return null;
  if (edge.evidence?.source === "syntax" && edge.evidence.resolution.status !== "resolved") return null;
  const via = new Set<string>();
  if (edge.evidence?.source === "syntax" && edge.evidence.resolution.status === "resolved") {
    const resolution = edge.evidence.resolution;
    for (const hop of resolution.via ?? []) { via.add(hop.file); via.add(hop.targetFile); }
    if (resolution.method === "receiver-hint") {
      const owner = index.symbols.get(resolution.receiver.classSymbol);
      if (owner === undefined) return null;
      via.add(owner.file);
    }
  }
  if ([...via].some((file) => !index.files.has(file))) return null;
  return { edge, source: sourceReceipt(index, edge.fromFile, receipt), target: sourceReceipt(index, targetFile, receipt),
    viaSources: [...via].sort(compareText).map((file) => sourceReceipt(index, file, receipt)),
    uncertainty: isReliableEdge(edge) ? [] : [edge.evidence?.source === "syntax" && edge.evidence.resolution.status === "resolved" && edge.evidence.resolution.method === "receiver-hint"
      ? "receiver-hint-not-runtime-type-proof" : "name-heuristic-or-unknown-provenance"] };
}

interface DiffFile {
  before: string | null;
  after: string | null;
  oldLines: Set<number>;
  newLines: Set<number>;
}

function diffPath(value: string, prefix: boolean): string | null {
  const path = value.split("\t")[0] ?? "";
  if (path === "/dev/null") return null;
  const normalized = prefix ? path.replace(/^[ab]\//, "") : path;
  if (!normalized || normalized.startsWith("/") || normalized.startsWith('"') || normalized.includes("\\") ||
    normalized.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new Error("osnova: unsupported diff path");
  }
  return normalized;
}

function parseDiff(diff: string): DiffFile[] & { tolerated?: number } {
  if (!diff.trim()) return [];
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let oldLine = 0, newLine = 0, oldLeft = 0, newLeft = 0;
  let hunkLine = 0, tolerated = 0;
  const finish = (): void => {
    if (oldLeft === 0 && newLeft === 0) return;
    if (oldLeft === newLeft) { tolerated += oldLeft; oldLeft = 0; newLeft = 0; return; }
    throw new Error(`osnova: incomplete unified diff hunk starting at line ${hunkLine}: the header promised ${oldLeft} more old and ${newLeft} more new lines; pass the exact diff output, not a summary`);
  };
  const lines = diff.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  for (const [number, line] of lines.entries()) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("\\ No newline")) continue;
      if (line.startsWith("-")) { file?.oldLines.add(oldLine++); oldLeft--; }
      else if (line.startsWith("+")) { file?.newLines.add(newLine++); newLeft--; }
      else if (line.startsWith(" ") || line === "") { oldLine++; newLine++; oldLeft--; newLeft--; }
      else if (line.startsWith("@@") && oldLeft === newLeft) { finish(); }
      else throw new Error(`osnova: invalid unified diff hunk line ${number + 1}: the hunk header promised ${oldLeft} more old and ${newLeft} more new lines; pass the exact diff output, not a summary`);
      if (oldLeft < 0 || newLeft < 0) throw new Error("osnova: invalid unified diff hunk counts; pass the exact diff output, not a summary");
      if (!line.startsWith("@@")) continue;
    }
    if (line.startsWith("diff --git ")) { finish(); file = undefined; }
    else if (line.startsWith("--- ") || line.startsWith("rename from ")) {
      finish();
      file = { before: diffPath(line.slice(line.startsWith("--- ") ? 4 : 12), line.startsWith("--- ")), after: null,
        oldLines: new Set(), newLines: new Set() };
      files.push(file);
    } else if (line.startsWith("+++ ") || line.startsWith("rename to ")) {
      if (file === undefined) throw new Error("osnova: missing unified diff source path");
      file.after = diffPath(line.slice(line.startsWith("+++ ") ? 4 : 10), line.startsWith("+++ "));
    } else if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (file === undefined || match === null) throw new Error("osnova: invalid unified diff header");
      hunkLine = number + 1;
      oldLine = Number(match[1]); oldLeft = Number(match[2] ?? 1);
      newLine = Number(match[3]); newLeft = Number(match[4] ?? 1);
      if (![oldLine, newLine, oldLeft, newLeft].every(Number.isSafeInteger)) throw new Error("osnova: invalid diff range");
    }
  }
  finish();
  if (files.length === 0) throw new Error("osnova: no supported unified diff paths");
  return Object.assign(files, { tolerated });
}

function innermostSymbolAt(symbols: readonly OsnovaSymbol[], line: number): OsnovaSymbol | undefined {
  let best: OsnovaSymbol | undefined;
  for (const symbol of symbols) {
    if (line < symbol.span.startLine || line > symbol.span.endLine) continue;
    if (best === undefined || symbol.span.startLine > best.span.startLine ||
      (symbol.span.startLine === best.span.startLine && (symbol.span.startCol > best.span.startCol ||
        (symbol.span.startCol === best.span.startCol && (symbol.span.endLine < best.span.endLine ||
          (symbol.span.endLine === best.span.endLine && symbol.span.endCol < best.span.endCol)))))) best = symbol;
  }
  return best;
}

function symbolText(file: FileCard, symbol: OsnovaSymbol): string {
  const lines = file.text.split("\n").slice(symbol.span.startLine - 1, symbol.span.endLine);
  if (lines.length === 1) return (lines[0] ?? "").slice(symbol.span.startCol, symbol.span.endCol);
  if (lines.length > 0) {
    lines[0] = (lines[0] ?? "").slice(symbol.span.startCol);
    lines[lines.length - 1] = (lines[lines.length - 1] ?? "").slice(0, symbol.span.endCol);
  }
  return lines.join("\n");
}

export function impact(base: OsnovaIndex, current: OsnovaIndex, options: ImpactOptions = {}): ImpactResult {
  const maxDepth = options.maxDepth ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) throw new RangeError("osnova: impact depth must be a nonnegative safe integer");
  const beforeReceipt = indexReceipt(base), afterReceipt = indexReceipt(current);
  const diffs = options.diff === undefined ? null : parseDiff(options.diff);
  const sameIndex = base === current;
  const prefix = options.diffPathPrefix === undefined || options.diffPathPrefix === "" ? null : `${options.diffPathPrefix.replace(/\/+$/, "")}/`;
  const indexed = (file: string): boolean => base.files.has(file) || current.files.has(file);
  // One basis for the whole diff: when a path names the workspace folder from the repository root, every path is
  // read from the root, and one outside the folder stays outside (`../name`) instead of matching a workspace file.
  const rootBased = prefix !== null && (diffs ?? []).some((diff) => [diff.before, diff.after].some((file) => file !== null && file.startsWith(prefix) && !indexed(file)));
  const localPath = (file: string | null): string | null =>
    file === null || !rootBased || prefix === null ? file : file.startsWith(prefix) ? file.slice(prefix.length) : path.posix.relative(prefix, file);
  for (const diff of diffs ?? []) { diff.before = localPath(diff.before); diff.after = localPath(diff.after); }
  const unindexedDiffFiles = new Set<string>();
  for (const diff of diffs ?? []) {
    const named = diff.after ?? diff.before;
    if (named === null) continue;
    if (!base.files.has(diff.before ?? named) && !current.files.has(diff.after ?? named)) unindexedDiffFiles.add(named);
    else if (diff.before !== null && diff.after !== null && diff.before !== diff.after && !current.files.has(diff.after)) unindexedDiffFiles.add(diff.after);
  }
  const renames = new Map<string, { path: string; basis: "diff-rename" | "identical-file-hash" }>();
  for (const diff of diffs ?? []) {
    if (diff.before !== null && diff.after !== null && diff.before !== diff.after && base.files.has(diff.before) && current.files.has(diff.after)) {
      renames.set(diff.before, { path: diff.after, basis: "diff-rename" });
    }
  }
  const removedFiles = [...base.files.values()].filter((file) => !current.files.has(file.path));
  const addedFiles = [...current.files.values()].filter((file) => !base.files.has(file.path));
  for (const file of removedFiles) {
    const matches = addedFiles.filter((other) => other.hash === file.hash);
    if (!renames.has(file.path) && matches.length === 1 && removedFiles.filter((other) => other.hash === file.hash).length === 1) {
      renames.set(file.path, { path: matches[0]!.path, basis: "identical-file-hash" });
    }
  }
  const changes: SymbolChange[] = [];
  const consumed = new Set<string>();
  const definition = (index: OsnovaIndex, symbol: OsnovaSymbol, receipt: IndexReceipt): DefinitionEvidence =>
    ({ symbol, receipt: sourceReceipt(index, symbol.file, receipt) });
  const attributed = new Map<OsnovaIndex, Map<string, Set<string>>>();
  const overlaps = (symbol: OsnovaSymbol, requested: "base" | "current"): boolean => {
    if (diffs === null) return false;
    const useBase = requested === "base" && !sameIndex;
    const index = useBase ? base : current;
    const perIndex = attributed.get(index) ?? new Map<string, Set<string>>();
    attributed.set(index, perIndex);
    let names = perIndex.get(symbol.file);
    if (names === undefined) {
      names = new Set();
      perIndex.set(symbol.file, names);
      const symbols = index.files.get(symbol.file)?.symbols ?? [];
      for (const diff of diffs) {
        if ((useBase ? diff.before : diff.after) !== symbol.file) continue;
        for (const line of useBase ? diff.oldLines : diff.newLines) {
          const innermost = innermostSymbolAt(symbols, line);
          if (innermost !== undefined) names.add(innermost.qualifiedName);
        }
      }
    }
    return names.has(symbol.qualifiedName);
  };
  for (const symbol of [...base.symbols.values()].sort((a, b) => compareText(a.qualifiedName, b.qualifiedName))) {
    const rename = renames.get(symbol.file);
    const local = symbol.qualifiedName.slice(symbol.file.length);
    let next = current.symbols.get(rename === undefined ? symbol.qualifiedName : `${rename.path}${local}`);
    let basis: SymbolChange["basis"] = rename?.basis ?? (diffs === null ? "indexed-span" : "diff-range");
    let inferred = false;
    if (next === undefined) {
      const candidates = [...current.symbols.values()].filter((candidate) => candidate.file === (rename?.path ?? symbol.file) &&
        candidate.kind === symbol.kind && candidate.span.startLine === symbol.span.startLine && candidate.span.startCol === symbol.span.startCol &&
        !base.symbols.has(candidate.qualifiedName) && !consumed.has(candidate.qualifiedName));
      if (candidates.length === 1 && (diffs === null || overlaps(symbol, "base") && overlaps(candidates[0]!, "current"))) {
        next = candidates[0]; basis = "same-position"; inferred = true;
      }
    }
    if (next !== undefined && consumed.has(next.qualifiedName)) next = undefined;
    if (next !== undefined) consumed.add(next.qualifiedName);
    const changed = next === undefined || symbol.qualifiedName !== next.qualifiedName ||
      (diffs === null ? symbolText(base.files.get(symbol.file)!, symbol) !== symbolText(current.files.get(next.file)!, next) ||
        symbol.signature !== next.signature : overlaps(symbol, "base") || overlaps(next, "current"));
    if (!changed) continue;
    changes.push({ kind: next === undefined ? "deleted" : symbol.qualifiedName !== next.qualifiedName ? "renamed" : "changed", basis,
      before: definition(base, symbol, beforeReceipt), after: next === undefined ? null : definition(current, next, afterReceipt),
      uncertainty: inferred ? ["symbol-identity-inferred"] : rename === undefined ? [] : ["file-identity-inferred"] });
  }
  for (const symbol of [...current.symbols.values()].sort((a, b) => compareText(a.qualifiedName, b.qualifiedName))) {
    if (!consumed.has(symbol.qualifiedName)) changes.push({ kind: "added", basis: diffs === null ? "indexed-span" : "diff-range",
      before: null, after: definition(current, symbol, afterReceipt), uncertainty: [] });
  }
  const files: { before: SourceReceipt | null; after: SourceReceipt | null }[] = [];
  const usedPaths = new Set<string>();
  for (const file of [...base.files.values()].sort((a, b) => compareText(a.path, b.path))) {
    const next = current.files.get(renames.get(file.path)?.path ?? file.path);
    if (next !== undefined) usedPaths.add(next.path);
    if (next?.hash === file.hash && next.path === file.path) continue;
    files.push({ before: sourceReceipt(base, file.path, beforeReceipt), after: next === undefined ? null : sourceReceipt(current, next.path, afterReceipt) });
  }
  for (const file of [...current.files.values()].sort((a, b) => compareText(a.path, b.path))) {
    if (!usedPaths.has(file.path)) files.push({ before: null, after: sourceReceipt(current, file.path, afterReceipt) });
  }
  const dependents: ImpactDependent[] = [];
  let dependentFrontier = 0;
  const unlistedImporters = new Set<string>();
  const fullyAttributed = (index: OsnovaIndex, file: string, side: "base" | "current"): boolean => {
    if (diffs === null) return false;
    const card = index.files.get(file);
    if (card === undefined) return false;
    const text = card.text.split("\n");
    let mentioned = false;
    for (const diff of diffs) {
      if ((side === "base" ? diff.before : diff.after) !== file) continue;
      mentioned = true;
      for (const line of side === "base" ? diff.oldLines : diff.newLines) {
        if ((text[line - 1] ?? "").trim() === "") continue;
        if (innermostSymbolAt(card.symbols, line) === undefined) return false;
      }
    }
    return mentioned;
  };
  const snapshots = sameIndex ? [["current", current, afterReceipt]] as const
    : [["base", base, beforeReceipt], ["current", current, afterReceipt]] as const;
  for (const [snapshot, index, receipt] of snapshots) {
    const seeds = new Set<string>();
    for (const change of changes) {
      const item = snapshot === "base" ? change.before : change.after;
      if (item !== null) seeds.add(item.symbol.qualifiedName);
    }
    const importerOnlyFiles = new Set<string>();
    for (const file of files) {
      const item = snapshot === "base" ? file.before : file.after;
      if (item === null) continue;
      const inPlace = file.before !== null && file.after !== null && file.before.file === file.after.file;
      if (inPlace && fullyAttributed(base, item.file, "base") && fullyAttributed(current, item.file, "current")) importerOnlyFiles.add(item.file);
      else seeds.add(item.file);
    }
    const inbound = new Map<string, RelationshipEvidence[]>();
    for (const edge of index.edges) {
      const evidence = relationshipEvidence(index, edge, receipt);
      const target = edge.toSymbol ?? edge.toFile;
      if (evidence === null || target === undefined) continue;
      const list = inbound.get(target) ?? []; list.push(evidence); inbound.set(target, list);
    }
    const visited = new Set(seeds);
    const queue = [...seeds].sort(compareText).map((node) => ({ node, path: [] as RelationshipEvidence[] }));
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const item = queue[cursor]!;
      for (const evidence of inbound.get(item.node) ?? []) {
        const node = evidence.edge.fromSymbol || evidence.edge.fromFile;
        if (visited.has(node)) continue;
        if (item.path.length >= maxDepth) { dependentFrontier++; continue; }
        visited.add(node);
        const path = [...item.path, evidence];
        dependents.push({ snapshot, symbol: index.symbols.get(node) ?? null, file: evidence.edge.fromFile,
          receipt: evidence.source, depth: path.length, path });
        queue.push({ node, path });
      }
    }
    for (const file of importerOnlyFiles) {
      for (const evidence of inbound.get(file) ?? []) {
        const node = evidence.edge.fromSymbol || evidence.edge.fromFile;
        if (!visited.has(node)) unlistedImporters.add(node);
      }
    }
  }
  for (const dependent of dependents) unlistedImporters.delete(dependent.symbol?.qualifiedName ?? dependent.file);
  return { base: beforeReceipt, current: afterReceipt, changes, files, dependents, omitted: { dependentFrontier, fileImporters: unlistedImporters.size },
    uncertainty: { unresolvedEdges: (sameIndex ? [current] : [base, current]).reduce((sum, index) => sum + index.edges.filter((edge) =>
      relationshipEvidence(index, edge, index === base ? beforeReceipt : afterReceipt) === null).length, 0),
    notes: ["indexed-graph-only", ...(sameIndex ? ["base-snapshot-is-current-index", "deleted-symbols-not-visible"] : []), "receipts-identify-indexed-content-not-disk-freshness", "rename-identity-is-not-proven", "one-shortest-path-per-dependent",
      ...(diffs === null ? [] : ["provided-diff-ranges-not-verified-against-source"]),
      ...(unindexedDiffFiles.size > 0 ? [`diff-files-not-in-index-${unindexedDiffFiles.size}:${[...unindexedDiffFiles].sort(compareText)[0]}`] : []),
      ...((diffs?.tolerated ?? 0) > 0 ? [`diff-short-by-${diffs!.tolerated}-context-lines-treated-as-unchanged`] : []),
      ...(beforeReceipt.diagnostics + afterReceipt.diagnostics > 0 ? ["index-diagnostics-present"] : [])] } };
}

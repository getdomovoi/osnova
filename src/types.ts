export const indexFormatVersion = 3 as const;

export type LanguageId =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "c_sharp";

export type CardLanguage = LanguageId | "fallback";

export interface SourceSpan {
  readonly startLine: number;
  readonly endLine: number;
  readonly startCol: number;
  readonly endCol: number;
}

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "struct"
  | "interface"
  | "trait"
  | "enum"
  | "type"
  | "constant";

export interface OsnovaSymbol {
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: SymbolKind;
  readonly file: string;
  readonly span: SourceSpan;
  readonly signature: string;
  readonly lineCount: number;
}

export type EdgeKind = "calls" | "references" | "imports";

export type EdgeResolution =
  | { readonly status: "resolved"; readonly method: "import-path" | "same-file-name" | "imported-file-name" | "unique-name" }
  | { readonly status: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly status: "unresolved"; readonly reason: "no-matching-symbol" | "import-target-unresolved" };

export type EdgeEvidence =
  | { readonly source: "syntax"; readonly resolution: EdgeResolution }
  | { readonly source: "unknown" };

export interface OsnovaEdge {
  readonly kind: EdgeKind;
  readonly fromFile: string;
  readonly fromSymbol: string;
  readonly toName: string;
  readonly line: number;
  readonly toSymbol?: string | undefined;
  readonly toFile?: string | undefined;
  readonly evidence?: EdgeEvidence | undefined;
}

export interface FileCard {
  readonly path: string;
  readonly language: CardLanguage;
  readonly hash: string;
  readonly size: number;
  readonly lineCount: number;
  readonly text: string;
  readonly symbols: readonly OsnovaSymbol[];
  readonly diagnostics?: readonly IndexDiagnostic[] | undefined;
}

export interface OsnovaIndex {
  readonly root: string;
  readonly files: ReadonlyMap<string, FileCard>;
  readonly symbols: ReadonlyMap<string, OsnovaSymbol>;
  readonly edges: readonly OsnovaEdge[];
  readonly diagnostics?: readonly IndexDiagnostic[] | undefined;
  incoming(qualifiedName: string): readonly OsnovaEdge[];
  outgoing(qualifiedName: string): readonly OsnovaEdge[];
  edgesForFile(path: string): readonly OsnovaEdge[];
}

export interface IndexDiagnostic {
  readonly phase: "scan" | "read" | "parse" | "cache";
  readonly path: string;
  readonly code: string;
}

export interface IndexHealthReport {
  readonly state: "fresh" | "stale" | "partial" | "unavailable";
  readonly diagnostics: readonly IndexDiagnostic[];
  readonly freshness: FreshnessReport | null;
}

export interface AskHit {
  readonly file: string;
  readonly line: number;
  readonly score: number;
  readonly symbol: OsnovaSymbol | null;
  readonly excerpt: string;
  readonly excerptStartLine: number;
}

export interface AskOptions {
  readonly in?: string | undefined;
  readonly limit?: number | undefined;
  readonly full?: boolean | undefined;
}

export interface AskResult {
  readonly hits: readonly AskHit[];
  readonly filesSearched: number;
}

export interface FindTextMatch {
  readonly line: number;
  readonly col: number;
  readonly text: string;
}

export interface FindTextGroup {
  readonly symbol: OsnovaSymbol | null;
  readonly file: string;
  readonly incomingEdges: number;
  readonly matches: readonly FindTextMatch[];
}

export interface FindTextOptions {
  readonly fixed?: boolean | undefined;
  readonly ignoreCase?: boolean | undefined;
  readonly in?: string | undefined;
  readonly limit?: number | undefined;
}

export interface FindTextDetailedOptions extends FindTextOptions {
  readonly matchesPerGroup?: number | undefined;
}

export interface FindTextResult {
  readonly scope: "indexed-text";
  readonly groups: FindTextGroup[];
  readonly totalGroups: number;
  readonly totalMatches: number;
  readonly omittedGroups: number;
  readonly omittedMatches: number;
  readonly truncated: boolean;
}

export interface SkeletonEntry {
  readonly symbol: OsnovaSymbol;
  readonly signature: string;
}

export interface SkeletonResult {
  readonly file: string;
  readonly language: CardLanguage;
  readonly lineCount: number;
  readonly entries: readonly SkeletonEntry[];
}

export type EdgeDirection = "in" | "out";

export interface CallerHit {
  readonly symbol: OsnovaSymbol | null;
  readonly qualifiedName: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly kind: EdgeKind;
  readonly depth: number;
  readonly resolved: boolean;
}

export interface CallersResult {
  readonly target: OsnovaSymbol;
  readonly hits: readonly CallerHit[];
}

export interface CallerEvidenceHit extends CallerHit {
  readonly edge: OsnovaEdge;
}

export interface CallersOptions {
  readonly direction?: EdgeDirection | undefined;
  readonly depth?: number | undefined;
}

export interface UnresolvedCallerEdge {
  readonly edge: OsnovaEdge;
  readonly depth: number;
}

export type CallersDetailedResult =
  | { readonly status: "ambiguous"; readonly candidates: readonly OsnovaSymbol[] }
  | {
      readonly status: "found";
      readonly scope: "indexed-graph";
      readonly direction: EdgeDirection;
      readonly depth: number;
      readonly target: OsnovaSymbol;
      readonly hits: readonly CallerEvidenceHit[];
      readonly unresolved: readonly UnresolvedCallerEdge[];
    };

export interface DirCluster {
  readonly dir: string;
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly internalEdges: number;
  readonly externalEdges: number;
  readonly hubs: readonly HubEntry[];
}

export interface HubEntry {
  readonly qualifiedName: string;
  readonly kind: SymbolKind;
  readonly file: string;
  readonly line: number;
  readonly inEdges: number;
  readonly outEdges: number;
}

export interface MapOptions {
  readonly maxDirs?: number | undefined;
}

export interface MapResult {
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly edgeCount: number;
  readonly clusters: readonly DirCluster[];
  readonly hotspots: readonly HubEntry[];
  readonly droppedDirs: number;
}

export interface MapCardOptions {
  readonly maxCodeUnits?: number | undefined;
  readonly maxDirs?: number | undefined;
  readonly staleCount?: number | undefined;
}

export interface FreshnessReport {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly deleted: readonly string[];
}

export interface BuildOptions {
  readonly cacheDir?: string | undefined;
  readonly onProgress?: ((event: ProgressEvent) => void) | undefined;
}

export interface ProgressEvent {
  readonly phase: "scan" | "extract" | "resolve" | "save";
  readonly done: number;
  readonly total: number;
}

export interface LoadIndexOptions {
  readonly cacheDir?: string | undefined;
}

export const maximumOsnovaMapCardCodeUnits = 16_384 as const;
export const maximumTextResponseCodeUnits = 16_384 as const;

export const maximumIndexedFileSizeBytes = 1_000_000 as const;

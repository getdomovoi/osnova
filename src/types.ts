export const indexFormatVersion = 12 as const;

export type LanguageId =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "c_sharp"
  | "c"
  | "cpp"
  | "objc"
  | "ruby"
  | "php"
  | "kotlin"
  | "swift"
  | "scala"
  | "dart"
  | "elixir"
  | "ocaml"
  | "zig"
  | "bash";

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
  | "constant"
  | "module";

export interface OsnovaSymbol {
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: SymbolKind;
  readonly file: string;
  readonly span: SourceSpan;
  readonly signature: string;
  readonly lineCount: number;
  readonly shadowed?: true | undefined;
  readonly exportedNames?: readonly string[] | undefined;
  readonly memberKind?: MemberKind | undefined;
  readonly heritage?: readonly SymbolBinding[] | undefined;
  readonly fields?: readonly string[] | undefined;
  readonly returns?: ReturnBinding | undefined;
  readonly returnTuple?: readonly (ReturnBinding | null)[] | undefined;
  readonly aliasOf?: Callee | undefined;
  readonly fieldTypes?: Readonly<Record<string, SymbolBinding>> | undefined;
  readonly unwrapped?: ReturnBinding | undefined;
  readonly elements?: ReturnBinding | undefined;
  readonly elementTypes?: Readonly<Record<string, SymbolBinding>> | undefined;
  readonly values?: ReturnBinding | undefined;
  readonly valueTypes?: Readonly<Record<string, SymbolBinding>> | undefined;
}

export type MemberKind = "instance" | "static" | "class" | "property" | "unknown";
export type ReceiverMode = "instance" | "class";
export type ReceiverBasis = "constructor" | "lexical" | "class-reference" | "annotation" | "return";

export type EdgeKind = "calls" | "references" | "imports" | "extends" | "routes";

export interface RouteInfo {
  readonly method: string;
  readonly path?: string | undefined;
}

// A route registration as the file card records it: what the site wrote, plus the handler's local
// qualified name when the handler is declared in the same file. Ground reads this from the core
// section so a route query never has to load the edge section.
export interface RouteSite extends RouteInfo {
  readonly line: number;
  readonly handler?: string | undefined;
}

export type EdgeResolution =
  | { readonly status: "resolved"; readonly method: "import-path" | "same-file-name" | "imported-file-name" | "unique-name" | "import-binding" | "lexical-definition"; readonly via?: undefined }
  | { readonly status: "resolved"; readonly method: "re-export-binding"; readonly via: readonly ExportHop[] }
  | { readonly status: "resolved"; readonly method: "receiver-hint"; readonly receiver: { readonly classSymbol: string; readonly mode: ReceiverMode; readonly basis: ReceiverBasis }; readonly via?: readonly ExportHop[] | undefined }
  | { readonly status: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly status: "unresolved"; readonly reason: "no-matching-symbol" | "import-target-unresolved" | "import-target-ambiguous" | "binding-blocked" | "bound-symbol-missing" | "shadowed-declaration" | "route-handler-inline" | "route-handler-wrapped" | "re-export-incomplete" | "re-export-cycle" | "receiver-unresolved" | "unbound-global"; readonly external?: string | undefined };

export type ReExport =
  | { readonly kind: "named"; readonly exportedName: string; readonly source: string; readonly importedName: string; readonly line: number }
  | { readonly kind: "star"; readonly source: string; readonly line: number }
  | { readonly kind: "namespace"; readonly exportedName: string; readonly source: string; readonly line: number }
  | { readonly kind: "blocked"; readonly exportedName: string; readonly line: number };

export interface ExportHop {
  readonly file: string;
  readonly line: number;
  readonly kind: "named" | "star" | "namespace";
  readonly exportedName: string;
  readonly importedName: string;
  readonly source: string;
  readonly targetFile: string;
}

export type SymbolBinding =
  | { readonly kind: "import"; readonly source: string; readonly importedName: string }
  | { readonly kind: "local"; readonly name: string };

export type Callee = SymbolBinding | { readonly kind: "method"; readonly owner: ReceiverOwner; readonly member: string; readonly mode?: ReceiverMode | undefined };
export type ReceiverOwner = SymbolBinding | { readonly kind: "return"; readonly of: Callee; readonly index?: number | undefined; readonly unwrapped?: true | undefined } | { readonly kind: "super"; readonly of: SymbolBinding } | { readonly kind: "field"; readonly of: ReceiverOwner; readonly member: string } | { readonly kind: "element"; readonly of: ReceiverOwner; readonly mode?: "value" | "either" | undefined };

export type ReturnBinding = SymbolBinding | { readonly kind: "this" };

export type EdgeBinding = SymbolBinding
  | { readonly kind: "instance"; readonly owner: ReceiverOwner; readonly basis: "constructor" | "lexical" | "annotation" | "return" }
  | { readonly kind: "member"; readonly owner: ReceiverOwner; readonly member: string; readonly mode: ReceiverMode; readonly basis: ReceiverBasis }
  | { readonly kind: "blocked"; readonly reason: "local-value" | "unsupported" | "ambiguous" | "unknown-receiver" | "unbound" | "inline-handler" | "wrapped-handler" };

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
  readonly binding?: EdgeBinding | undefined;
  readonly route?: RouteInfo | undefined;
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
  readonly reExports?: readonly ReExport[] | undefined;
  readonly routes?: readonly RouteSite[] | undefined;
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
  readonly inlineShortDefinitions?: number | undefined;
}

export interface AskResult {
  readonly hits: readonly AskHit[];
  readonly filesSearched: number;
}

export interface AskDetailedResult extends AskResult {
  readonly scope: "indexed-definitions-and-text";
  readonly totalCandidates: number;
  readonly omittedHits: number;
  readonly truncated: boolean;
}

export interface FindTextMatch {
  readonly line: number;
  readonly col: number;
  readonly length: number;
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

export interface NameMatches { readonly candidates: readonly string[]; readonly total: number }

export interface UnresolvedCallerEdge {
  readonly edge: OsnovaEdge;
  readonly depth: number;
  readonly nameMatches: NameMatches;
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
      readonly reach?: SymbolReach | undefined;
    };

export interface DirCluster {
  readonly dir: string;
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly internalEdges: number;
  readonly externalEdges: number;
  readonly hubs: readonly HubEntry[];
  readonly droppedHubs: number;
}

export interface ReachSpread {
  readonly edges: number;
  readonly files: number;
  readonly dirs: number;
}

export interface ReachDepthTwo {
  readonly edges: number;
  readonly files: number;
  readonly capped: boolean;
}

export interface SymbolReach {
  readonly d1: ReachSpread;
  readonly d2?: ReachDepthTwo | undefined;
  readonly unresolvedSameName: number;
  readonly tests: number;
}

export interface HubEntry {
  readonly qualifiedName: string;
  readonly kind: SymbolKind;
  readonly file: string;
  readonly line: number;
  readonly inEdges: number;
  readonly inFiles: number;
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
  readonly droppedHotspots: number;
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
  readonly phase: "scan" | "seed" | "extract" | "resolve" | "save";
  readonly done: number;
  readonly total: number;
  readonly sibling?: string | undefined;
  readonly skippedSymlinkedDirectories?: readonly string[] | undefined;
}

export interface LoadIndexOptions {
  readonly cacheDir?: string | undefined;
}

export const maximumOsnovaMapCardCodeUnits = 16_384 as const;
export const maximumTextResponseCodeUnits = 16_384 as const;

export const maximumIndexedFileSizeBytes = 1_000_000 as const;

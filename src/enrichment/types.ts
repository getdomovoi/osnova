import type { LanguageId } from "../types.js";

export interface LspLaunchSpec {
  readonly id: string;
  readonly executable: string;
  readonly args?: readonly string[] | undefined;
  readonly workspace: string;
  readonly languages: readonly LanguageId[];
}

export interface LspLimits {
  readonly requestTimeoutMs: number;
  readonly sessionTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly maxRequests: number;
  readonly maxPending: number;
  readonly maxMessageBytes: number;
  readonly maxSessionBytes: number;
  readonly maxMessages: number;
}

export interface LspPolicy {
  readonly version: 1;
  readonly servers: readonly LspLaunchSpec[];
  readonly limits?: Partial<LspLimits> | undefined;
}

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface LspQuery {
  readonly file: string;
  readonly sourceHash: string;
  readonly method: "references" | "definition";
  readonly position: LspPosition;
}

export interface LspLocation {
  readonly file: string;
  readonly range: LspRange;
  readonly sourceHash: string;
}

export interface LspEvidence {
  readonly source: "lsp";
  readonly claim: "server-locations";
  readonly serverId: string;
  readonly launchHash: string;
  readonly method: "textDocument/references" | "textDocument/definition";
  readonly positionEncoding: "utf-16";
  readonly dependencyScope: "indexed-workspace";
}

export interface LspQueryResult {
  readonly query: LspQuery;
  readonly language: LanguageId;
  readonly baseGeneration: string;
  readonly workspaceHash: string;
  readonly status: "complete" | "partial";
  readonly locations: readonly LspLocation[];
  readonly evidence: LspEvidence;
}

export interface LspDiagnostic {
  readonly code: string;
  readonly serverId?: string | undefined;
  readonly file?: string | undefined;
}

export interface LspEnrichmentResult {
  readonly version: 1;
  readonly root: string;
  readonly baseGeneration: string;
  readonly workspaceHash: string;
  readonly policy: LspPolicy | null;
  readonly status: "disabled" | "complete" | "partial" | "unavailable";
  readonly queries: readonly LspQuery[];
  readonly results: readonly LspQueryResult[];
  readonly diagnostics: readonly LspDiagnostic[];
  readonly reused: number;
}

export interface LspCacheOptions {
  readonly cacheDir?: string | undefined;
  readonly baseGeneration?: string | undefined;
}

export interface LspRefreshOptions extends LspCacheOptions {
  readonly enabled?: boolean | undefined;
  readonly policy?: LspPolicy | undefined;
  /** The approval `configureLspEnrichment` returned; required to launch a stored policy instead of `policy`. */
  readonly approve?: string | undefined;
  readonly queries?: readonly LspQuery[] | undefined;
  readonly signal?: AbortSignal | undefined;
}

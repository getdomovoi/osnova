import type { IndexDiagnostic, IndexHealthReport, OsnovaIndex } from "../types.js";
import { freshness, isStale } from "./incremental.js";
import { IndexingError } from "./diagnostics.js";

export async function indexHealth(index: OsnovaIndex): Promise<IndexHealthReport> {
  const diagnostics: readonly IndexDiagnostic[] = index.diagnostics ?? [
    { phase: "cache", path: ".", code: "health-unverified" },
  ];
  try {
    const report = await freshness(index, index.root);
    return {
      state: isStale(report) ? "stale" : diagnostics.length > 0 ? "partial" : "fresh",
      diagnostics,
      freshness: report,
    };
  } catch (error) {
    return {
      state: "unavailable",
      diagnostics: [...diagnostics, error instanceof IndexingError
        ? error.diagnostic
        : { phase: "scan", path: ".", code: "freshness-unavailable" }],
      freshness: null,
    };
  }
}

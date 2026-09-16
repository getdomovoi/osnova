import type { IndexDiagnostic } from "../types.js";

export class IndexingError extends Error {
  constructor(readonly diagnostic: IndexDiagnostic, cause?: unknown) {
    super(`osnova: ${diagnostic.phase} failed for ${diagnostic.path}: ${diagnostic.code}`, { cause });
  }
}

export class SectionError extends Error {}

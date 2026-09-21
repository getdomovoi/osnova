import { parentPort } from "node:worker_threads";
import { extractCard } from "./build.js";
import { IndexingError } from "./diagnostics.js";
import type { ExtractRequest, ExtractResponse } from "./extractPool.js";

const port = parentPort;
if (port === null) throw new Error("osnova: extract worker started without a parent port");

port.on("message", (request: ExtractRequest) => {
  void extractCard(request.absRoot, request.relPath)
    .then(({ card, rawEdges }) => {
      port.postMessage({ id: request.id, ok: true, card, rawEdges } satisfies ExtractResponse);
    })
    .catch((error: unknown) => {
      const cause = error instanceof Error && error.cause !== undefined ? String(error.cause) : undefined;
      port.postMessage({
        id: request.id,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof IndexingError ? { diagnostic: error.diagnostic } : {}),
        ...(cause === undefined ? {} : { cause }),
      } satisfies ExtractResponse);
    });
});

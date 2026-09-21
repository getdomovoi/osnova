import { existsSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { FileCard, IndexDiagnostic } from "../types.js";
import type { RawEdgeItem } from "./indexImpl.js";
import { IndexingError } from "./diagnostics.js";

export interface ExtractRequest {
  readonly id: number;
  readonly absRoot: string;
  readonly relPath: string;
}

export type ExtractResponse =
  | { readonly id: number; readonly ok: true; readonly card: FileCard; readonly rawEdges: RawEdgeItem[] }
  | { readonly id: number; readonly ok: false; readonly message: string; readonly diagnostic?: IndexDiagnostic | undefined; readonly cause?: string | undefined };

export interface ExtractedFile {
  readonly card: FileCard;
  readonly rawEdges: RawEdgeItem[];
}

export type ExtractOne = (absRoot: string, relPath: string) => Promise<ExtractedFile>;

export const EXTRACT_POOL_MIN_FILES = 32;
const EXTRACT_POOL_MAX_WORKERS = 8;

export function extractWorkerCount(fileCount: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OSNOVA_EXTRACT_WORKERS;
  let requested: number;
  if (raw !== undefined && /^\d+$/.test(raw.trim())) {
    requested = Number(raw.trim());
  } else if (fileCount < EXTRACT_POOL_MIN_FILES) {
    return 0;
  } else {
    requested = Math.min(os.availableParallelism() - 1, EXTRACT_POOL_MAX_WORKERS);
  }
  return Math.max(0, Math.min(requested, fileCount));
}

function workerScript(): { url: URL; execArgv?: string[] } | undefined {
  const fromSource = import.meta.url.endsWith(".ts");
  const url = new URL(fromSource ? "./extractWorker.ts" : "./extractWorker.js", import.meta.url);
  if (!existsSync(fileURLToPath(url))) return undefined;
  return fromSource ? { url, execArgv: ["--import", "tsx"] } : { url };
}

function rebuildError(response: Extract<ExtractResponse, { ok: false }>): Error {
  const cause = response.cause === undefined ? undefined : new Error(response.cause);
  if (response.diagnostic !== undefined) return new IndexingError(response.diagnostic, cause);
  return new Error(response.message, cause === undefined ? undefined : { cause });
}

async function extractSequential(
  absRoot: string,
  paths: readonly string[],
  extractOne: ExtractOne,
  onDone?: (done: number) => void,
): Promise<ExtractedFile[]> {
  const results: ExtractedFile[] = [];
  for (let i = 0; i < paths.length; i += 1) {
    const relPath = paths[i];
    if (relPath === undefined) continue;
    results.push(await extractOne(absRoot, relPath));
    onDone?.(i + 1);
  }
  return results;
}

async function extractWithPool(
  absRoot: string,
  paths: readonly string[],
  script: { url: URL; execArgv?: string[] },
  workerCount: number,
  onDone?: (done: number) => void,
): Promise<ExtractedFile[]> {
  const results: (ExtractedFile | undefined)[] = new Array<ExtractedFile | undefined>(paths.length);
  const failures = new Map<number, Error>();
  const current = new Map<Worker, number>();
  const workers: Worker[] = [];
  let next = 0;
  let completed = 0;
  let closing = false;
  let settle: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const dispatch = (worker: Worker): void => {
    if (failures.size === 0) {
      while (next < paths.length && paths[next] === undefined) next += 1;
      if (next < paths.length) {
        const id = next;
        next += 1;
        current.set(worker, id);
        worker.postMessage({ id, absRoot, relPath: paths[id] as string } satisfies ExtractRequest);
        return;
      }
    }
    if (current.size === 0) settle?.();
  };

  const failWorker = (worker: Worker, error: Error): void => {
    if (closing) return;
    const id = current.get(worker);
    if (id === undefined) return;
    current.delete(worker);
    failures.set(id, error);
    if (current.size === 0) settle?.();
  };

  try {
    for (let i = 0; i < workerCount; i += 1) {
      const worker = new Worker(script.url, { ...(script.execArgv === undefined ? {} : { execArgv: script.execArgv }) });
      workers.push(worker);
      worker.on("message", (response: ExtractResponse) => {
        if (closing || current.get(worker) !== response.id) return;
        current.delete(worker);
        completed += 1;
        if (response.ok) results[response.id] = { card: response.card, rawEdges: response.rawEdges };
        else failures.set(response.id, rebuildError(response));
        onDone?.(completed);
        dispatch(worker);
      });
      worker.on("error", (error: Error) => failWorker(worker, error));
      worker.on("exit", (code) => failWorker(worker, new Error(`osnova: extract worker exited with code ${code}`)));
    }
    for (const worker of workers) dispatch(worker);
    await finished;
  } finally {
    closing = true;
    await Promise.all(workers.map((worker) => worker.terminate()));
  }

  const firstFailure = [...failures.keys()].sort((a, b) => a - b)[0];
  if (firstFailure !== undefined) throw failures.get(firstFailure);
  return results.map((entry, id) => {
    if (entry === undefined) throw new Error(`osnova: extract worker returned no result for ${paths[id] ?? id}`);
    return entry;
  });
}

export async function extractCards(
  absRoot: string,
  paths: readonly string[],
  extractOne: ExtractOne,
  onDone?: (done: number) => void,
): Promise<ExtractedFile[]> {
  const workerCount = extractWorkerCount(paths.length);
  const script = workerCount > 0 ? workerScript() : undefined;
  if (workerCount === 0 || script === undefined) return extractSequential(absRoot, paths, extractOne, onDone);
  return extractWithPool(absRoot, paths, script, workerCount, onDone);
}

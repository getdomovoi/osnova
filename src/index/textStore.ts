import { closeSync, openSync, readSync } from "node:fs";
import type { FileCard, OsnovaIndex } from "../types.js";
import { IndexingError } from "./diagnostics.js";
import { sha256Hex } from "./scan.js";

export interface TextLayout {
  readonly offsets: ReadonlyMap<string, readonly [offset: number, length: number]>;
  readonly bytes: Buffer;
  readonly hash: string;
}

export interface PreviousText {
  readonly path: string;
  readonly hash: string;
  readonly offsets: ReadonlyMap<string, readonly [number, number]>;
  readonly hashes: ReadonlyMap<string, string>;
}

const lazySources = new WeakMap<FileCard, { path: string; offset: number; length: number; hash: string }>();

export function previousTextFrom(index: OsnovaIndex): PreviousText | undefined {
  let textPath: string | undefined;
  const offsets = new Map<string, readonly [number, number]>();
  const hashes = new Map<string, string>();
  for (const card of index.files.values()) {
    const source = lazySources.get(card);
    if (source === undefined) continue;
    textPath ??= source.path;
    if (source.path !== textPath) return undefined;
    offsets.set(card.path, [source.offset, source.length]);
    hashes.set(card.path, source.hash);
  }
  return textPath === undefined ? undefined : { path: textPath, hash: "", offsets, hashes };
}

export function serializeText(index: OsnovaIndex, previous?: PreviousText | undefined): TextLayout {
  const cards = [...index.files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks: Buffer[] = [];
  const offsets = new Map<string, readonly [number, number]>();
  let cursor = 0;
  let fd: number | undefined;
  try {
    for (const card of cards) {
      const old = previous?.offsets.get(card.path);
      let chunk: Buffer;
      if (
        old !== undefined &&
        previous!.hashes.get(card.path) === card.hash &&
        lazySources.get(card)?.path === previous!.path
      ) {
        fd ??= openSync(previous!.path, "r");
        chunk = Buffer.allocUnsafe(old[1]);
        let read = 0;
        while (read < old[1]) {
          const n = readSync(fd, chunk, read, old[1] - read, old[0] + read);
          if (n === 0) break;
          read += n;
        }
        if (read !== old[1]) {
          throw new IndexingError(
            { phase: "cache", path: previous!.path, code: "cache-read-failed" },
            new Error("osnova: short text copy"),
          );
        }
      } else {
        chunk = Buffer.from(card.text, "utf8");
      }
      offsets.set(card.path, [cursor, chunk.length]);
      chunks.push(chunk);
      cursor += chunk.length;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const bytes = Buffer.concat(chunks, cursor);
  return { offsets, bytes, hash: sha256Hex(bytes) };
}

export function readTextSlice(textPath: string, offset: number, length: number): string {
  const buffer = Buffer.allocUnsafe(length);
  let fd: number | undefined;
  try {
    fd = openSync(textPath, "r");
    let read = 0;
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, offset + read);
      if (count === 0) break;
      read += count;
    }
    if (read !== length) throw new Error(`osnova: short text read (${read} of ${length} bytes)`);
  } catch (error) {
    throw new IndexingError({ phase: "cache", path: textPath, code: "cache-read-failed" }, error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return buffer.toString("utf8");
}

export function lazyTextCard(card: Omit<FileCard, "text">, textPath: string, offset: number, length: number, expectedHash: string): FileCard {
  let cached: string | undefined;
  const lazy = { ...card } as FileCard & { text: string };
  Object.defineProperty(lazy, "text", {
    enumerable: true,
    configurable: false,
    get(): string {
      if (cached !== undefined) return cached;
      const source = lazySources.get(lazy)!;
      const text = readTextSlice(source.path, source.offset, source.length);
      if (source.length > 0 && sha256Hex(text) !== source.hash) {
        throw new IndexingError({ phase: "cache", path: source.path, code: "cache-read-failed" }, new Error("osnova: cached text hash mismatch"));
      }
      cached = text;
      return text;
    },
  });
  lazySources.set(lazy, { path: textPath, offset, length, hash: expectedHash });
  return lazy;
}

export function rebindPublishedText(
  index: OsnovaIndex,
  textPath: string,
  offsets: ReadonlyMap<string, readonly [number, number]>,
): void {
  for (const card of index.files.values()) {
    const source = lazySources.get(card);
    if (source === undefined || source.path !== textPath) continue;
    const next = offsets.get(card.path);
    if (next === undefined) continue;
    lazySources.set(card, { path: textPath, offset: next[0], length: next[1], hash: source.hash });
  }
}

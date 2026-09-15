import { closeSync, openSync, readSync } from "node:fs";
import type { FileCard, OsnovaIndex } from "../types.js";
import { IndexingError } from "./diagnostics.js";
import { sha256Hex } from "./scan.js";

export interface TextLayout {
  readonly offsets: ReadonlyMap<string, readonly [offset: number, length: number]>;
  readonly bytes: Buffer;
  readonly hash: string;
}

export function serializeText(index: OsnovaIndex): TextLayout {
  const cards = [...index.files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks: Buffer[] = [];
  const offsets = new Map<string, readonly [number, number]>();
  let cursor = 0;
  for (const card of cards) {
    const chunk = Buffer.from(card.text, "utf8");
    offsets.set(card.path, [cursor, chunk.length]);
    chunks.push(chunk);
    cursor += chunk.length;
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
      const text = readTextSlice(textPath, offset, length);
      if (length > 0 && sha256Hex(text) !== expectedHash) {
        throw new IndexingError({ phase: "cache", path: textPath, code: "cache-read-failed" }, new Error("osnova: cached text hash mismatch"));
      }
      cached = text;
      return text;
    },
  });
  return lazy;
}

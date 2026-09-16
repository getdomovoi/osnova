import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import type { FileCard, OsnovaIndex } from "../types.js";
import { IndexingError, SectionError } from "./diagnostics.js";
import { sha256Hex } from "./scan.js";

export interface TextLayout {
  readonly offsets: ReadonlyMap<string, readonly [offset: number, length: number]>;
  readonly bytes: Buffer;
  readonly hash: string;
}

export interface PreviousText {
  readonly path: string;
  readonly hash: string;
  readonly bytes: number;
  readonly offsets: ReadonlyMap<string, readonly [number, number]>;
  readonly hashes: ReadonlyMap<string, string>;
}

interface LazySource {
  readonly path: string;
  readonly offset: number;
  readonly length: number;
  readonly hash: string;
  readonly sectionHash: string;
  readonly sectionBytes: number;
}

const lazySources = new WeakMap<FileCard, LazySource>();

export function previousTextFrom(index: OsnovaIndex): PreviousText | undefined {
  let section: LazySource | undefined;
  const offsets = new Map<string, readonly [number, number]>();
  const hashes = new Map<string, string>();
  for (const card of index.files.values()) {
    const source = lazySources.get(card);
    if (source === undefined) continue;
    section ??= source;
    if (source.path !== section.path || source.sectionHash !== section.sectionHash ||
      source.sectionBytes !== section.sectionBytes) return undefined;
    offsets.set(card.path, [source.offset, source.length]);
    hashes.set(card.path, source.hash);
  }
  return section === undefined
    ? undefined
    : { path: section.path, hash: section.sectionHash, bytes: section.sectionBytes, offsets, hashes };
}

function verifiedPreviousBytes(previous: PreviousText): Buffer | undefined {
  let data: Buffer;
  try {
    data = readFileSync(previous.path);
  } catch {
    return undefined;
  }
  return data.length === previous.bytes && sha256Hex(data) === previous.hash ? data : undefined;
}

export function serializeText(index: OsnovaIndex, previous?: PreviousText | undefined): TextLayout {
  const cards = [...index.files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const reusable = (card: FileCard): readonly [number, number] | undefined => {
    if (previous === undefined) return undefined;
    const old = previous.offsets.get(card.path);
    if (old === undefined || previous.hashes.get(card.path) !== card.hash) return undefined;
    return lazySources.get(card)?.path === previous.path ? old : undefined;
  };
  const source = previous !== undefined && cards.some((card) => reusable(card) !== undefined)
    ? verifiedPreviousBytes(previous) : undefined;
  const chunks: Buffer[] = [];
  const offsets = new Map<string, readonly [number, number]>();
  let cursor = 0;
  for (const card of cards) {
    const old = source === undefined ? undefined : reusable(card);
    const chunk = old !== undefined && old[0] + old[1] <= source!.length
      ? source!.subarray(old[0], old[0] + old[1])
      : Buffer.from(card.text, "utf8");
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

export function lazyTextCard(
  card: Omit<FileCard, "text">,
  textPath: string,
  offset: number,
  length: number,
  expectedHash: string,
  sectionHash: string,
  sectionBytes: number,
): FileCard {
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
        throw new IndexingError({ phase: "cache", path: source.path, code: "cache-read-failed" }, new SectionError("osnova: cached text hash mismatch"));
      }
      cached = text;
      return text;
    },
  });
  lazySources.set(lazy, { path: textPath, offset, length, hash: expectedHash, sectionHash, sectionBytes });
  return lazy;
}

export function rebindPublishedText(
  index: OsnovaIndex,
  textPath: string,
  offsets: ReadonlyMap<string, readonly [number, number]>,
  sectionHash: string,
  sectionBytes: number,
): void {
  for (const card of index.files.values()) {
    const source = lazySources.get(card);
    if (source === undefined || source.path !== textPath) continue;
    const next = offsets.get(card.path);
    if (next === undefined) continue;
    lazySources.set(card, { path: textPath, offset: next[0], length: next[1], hash: source.hash, sectionHash, sectionBytes });
  }
}

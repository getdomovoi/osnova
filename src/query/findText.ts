import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import type { FindTextGroup, FindTextMatch, FindTextOptions, OsnovaIndex } from "../types.js";
import type { FindTextDetailedOptions, FindTextResult } from "../types.js";
import { matchInPath } from "./context.js";

const DEFAULT_GROUP_LIMIT = 50;
const MATCHES_PER_GROUP = 10;
export const DEFAULT_PATTERN_BUDGET_MS = 5_000;
const INLINE_WORK_LIMIT = 64;

export interface FindTextBudgetOptions extends FindTextDetailedOptions {
  readonly budgetMs?: number | undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findText(
  index: OsnovaIndex,
  pattern: string,
  options?: FindTextOptions,
): FindTextGroup[] {
  return findTextDetailed(index, pattern, {
    ...options,
    limit: options?.limit ?? DEFAULT_GROUP_LIMIT,
    matchesPerGroup: MATCHES_PER_GROUP,
  }).groups;
}

export function findTextDetailed(
  index: OsnovaIndex,
  pattern: string,
  options?: FindTextBudgetOptions,
): FindTextResult {
  for (const value of [options?.limit, options?.matchesPerGroup]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError("osnova: search limits must be nonnegative safe integers");
    }
  }
  const budgetMs = options?.budgetMs ?? DEFAULT_PATTERN_BUDGET_MS;
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) {
    throw new RangeError("osnova: the pattern budget must be a positive safe integer of milliseconds");
  }
  const source = options?.fixed === true ? escapeRegExp(pattern) : pattern;
  const flags = options?.ignoreCase === true ? "gi" : "g";
  try {
    new RegExp(source, flags);
  } catch (error) {
    throw new Error(`osnova: invalid pattern ${JSON.stringify(pattern)}: ${String(error)}`, {
      cause: error,
    });
  }
  const filter = options?.in ?? "";
  const groupLimit = options?.limit ?? Infinity;
  const matchLimit = options?.matchesPerGroup ?? Infinity;

  const paths: string[] = [];
  const texts: string[] = [];
  for (const path of [...index.files.keys()].sort()) {
    if (!matchInPath([path], filter)) continue;
    const text = index.files.get(path)?.text ?? "";
    if (text.length === 0) continue;
    paths.push(path);
    texts.push(text);
  }
  const work = patternWork(source);
  const found = work !== null && work <= INLINE_WORK_LIMIT
    ? scanTexts(texts, source, flags, matchLimit)
    : scanInWorker(texts, source, flags, matchLimit, budgetMs, pattern);

  interface Group {
    file: string;
    symbolQ: string | null;
    matches: FindTextMatch[];
  }
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  let totalMatches = 0;
  let linesOf = -1;
  let lines: string[] = [];
  for (let at = 0; at < found.length;) {
    const fileAt = found[at]!;
    const lineAt = found[at + 1]!;
    const count = found[at + 2]!;
    const kept = found[at + 3]!;
    at += 4;
    const path = paths[fileAt]!;
    if (linesOf !== fileAt) {
      lines = texts[fileAt]!.split("\n");
      linesOf = fileAt;
    }
    const line = lines[lineAt] ?? "";
    totalMatches += count;
    const symbolQ = innermostForLine(index.files.get(path)?.symbols ?? [], lineAt + 1);
    const key = `${path}\u0000${symbolQ ?? "<module>"}`;
    let group = byKey.get(key);
    if (group === undefined) {
      group = { file: path, symbolQ, matches: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    for (let k = 0; k < kept; k += 1, at += 2) {
      if (group.matches.length >= matchLimit) continue;
      const hit: FindTextMatch = { line: lineAt + 1, col: found[at]!, length: found[at + 1]!, text: line };
      const last = group.matches[group.matches.length - 1];
      if (last === undefined || last.line !== hit.line || last.col !== hit.col) {
        group.matches.push(hit);
      }
    }
  }

  const ranked = groups.map((group) => {
    const incoming =
      group.symbolQ !== null
        ? index.incoming(group.symbolQ).length
        : 0;
    const symbol = group.symbolQ !== null ? (index.symbols.get(group.symbolQ) ?? null) : null;
    return { group, incoming, symbol };
  });
  ranked.sort(
    (a, b) =>
      b.incoming - a.incoming ||
      (a.group.file < b.group.file ? -1 : a.group.file > b.group.file ? 1 : 0) ||
      (a.group.symbolQ ?? "").localeCompare(b.group.symbolQ ?? ""),
  );
  const selected = ranked.slice(0, groupLimit).map(({ group, incoming, symbol }) => ({
    file: group.file,
    symbol,
    incomingEdges: incoming,
    matches: group.matches,
  }));
  const omittedMatches = totalMatches - selected.reduce((count, group) => count + group.matches.length, 0);
  return {
    scope: "indexed-text",
    groups: selected,
    totalGroups: groups.length,
    totalMatches,
    omittedGroups: groups.length - selected.length,
    omittedMatches,
    truncated: omittedMatches > 0,
  };
}

// Also runs inside the scan worker through its source text, so it must not reach outside its own body.
// Each line with a match yields [file, line, matches, kept, col, length, ...] with at most `keep` pairs.
function scanTexts(texts: readonly string[], source: string, flags: string, keep: number): number[] {
  const regex = new RegExp(source, flags);
  const out: number[] = [];
  for (let file = 0; file < texts.length; file += 1) {
    const lines = (texts[file] ?? "").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      regex.lastIndex = 0;
      let match = regex.exec(line);
      if (match === null) continue;
      const head = out.length;
      out.push(file, i, 0, 0);
      let count = 0;
      let kept = 0;
      while (match !== null) {
        count += 1;
        if (kept < keep) {
          out.push(match.index, match[0].length);
          kept += 1;
        }
        if (match[0].length === 0) regex.lastIndex += 1;
        match = regex.exec(line);
      }
      out[head + 2] = count;
      out[head + 3] = kept;
    }
  }
  return out;
}

const WORKER_SOURCE = `"use strict";
const { workerData } = require("node:worker_threads");
const scanTexts = (${scanTexts.toString()});
const { port, done, texts, source, flags, keep } = workerData;
try {
  const found = Int32Array.from(scanTexts(texts, source, flags, keep));
  port.postMessage({ ok: true, found }, [found.buffer]);
} catch (error) {
  port.postMessage({ ok: false, message: String(error && error.message ? error.message : error) });
}
Atomics.store(done, 0, 1);
Atomics.notify(done, 0);
`;

type WorkerReply = { readonly ok: true; readonly found: Int32Array } | { readonly ok: false; readonly message: string };

// One backtracking exec call never yields, so no check between lines can stop it. A pattern whose cost
// is not proven small runs on a worker thread that is abandoned and terminated at the deadline.
function scanInWorker(texts: readonly string[], source: string, flags: string, keep: number, budgetMs: number, pattern: string): ArrayLike<number> {
  const done = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    execArgv: [],
    workerData: { port: port2, done, texts, source, flags, keep },
    transferList: [port2],
  });
  worker.unref();
  try {
    Atomics.wait(done, 0, 0, budgetMs);
    const received = receiveMessageOnPort(port1)?.message as WorkerReply | undefined;
    if (received === undefined) {
      throw new Error(
        `osnova: pattern-budget-exceeded: ${JSON.stringify(pattern)} did not finish within ${budgetMs} ms over ` +
        `${texts.length} indexed files, so no result is returned. This is a refusal, not an absence of matches. ` +
        "A nested quantifier such as (a+)+ can backtrack without end: rewrite the pattern without one, pass fixed " +
        "for a literal, or narrow the search with in.",
      );
    }
    if (!received.ok) throw new Error(`osnova: pattern scan failed for ${JSON.stringify(pattern)}: ${received.message}`);
    return received.found;
  } finally {
    port1.close();
    void worker.terminate();
  }
}

// Worst-case steps per start position of a pattern with no quantifier and no backreference, from the
// ways each alternation can match. Null means no bound is proven, and the pattern goes to the worker.
function patternWork(source: string): number | null {
  let at = 0;
  const quantifierAt = (position: number): boolean => {
    const char = source[position];
    return char === "*" || char === "+" || char === "?" || (char === "{" && /^\{\d+(?:,\d*)?\}/.test(source.slice(position)));
  };
  const alternation = (): { work: number; paths: number } | null => {
    let work = 0;
    let paths = 0;
    for (;;) {
      const branch = sequence();
      if (branch === null) return null;
      work += branch.work;
      paths += branch.paths;
      if (source[at] !== "|") return { work, paths };
      at += 1;
    }
  };
  const sequence = (): { work: number; paths: number } | null => {
    const atoms: { work: number; paths: number }[] = [];
    while (at < source.length && source[at] !== "|" && source[at] !== ")") {
      const next = atom();
      if (next === null || quantifierAt(at)) return null;
      atoms.push(next);
    }
    let work = 0;
    let paths = 1;
    for (let i = atoms.length - 1; i >= 0; i -= 1) {
      work = atoms[i]!.work + atoms[i]!.paths * work;
      paths *= atoms[i]!.paths;
    }
    return { work, paths };
  };
  const atom = (): { work: number; paths: number } | null => {
    const char = source[at];
    if (char === "(") {
      at += 1;
      let lookaround = false;
      if (source[at] === "?") {
        at += 1;
        const kind = source[at];
        if (kind === ":") at += 1;
        else if (kind === "=" || kind === "!") { at += 1; lookaround = true; }
        else if (kind === "<" && (source[at + 1] === "=" || source[at + 1] === "!")) { at += 2; lookaround = true; }
        else if (kind === "<") {
          const close = source.indexOf(">", at);
          if (close < 0) return null;
          at = close + 1;
        } else return null;
      }
      const inner = alternation();
      if (inner === null || source[at] !== ")") return null;
      at += 1;
      return lookaround ? { work: inner.work, paths: 1 } : inner;
    }
    if (char === "[") {
      at += 1;
      if (source[at] === "^") at += 1;
      while (at < source.length && source[at] !== "]") at += source[at] === "\\" ? 2 : 1;
      if (at >= source.length) return null;
      at += 1;
      return { work: 1, paths: 1 };
    }
    if (char === "\\") {
      const escaped = source[at + 1];
      if (escaped === undefined || escaped === "k" || (escaped >= "1" && escaped <= "9")) return null;
      at += 2;
      return { work: 1, paths: 1 };
    }
    if (char === undefined || quantifierAt(at)) return null;
    at += 1;
    return { work: 1, paths: 1 };
  };
  const whole = alternation();
  return whole === null || at !== source.length ? null : whole.work;
}

function innermostForLine(
  symbols: readonly { qualifiedName: string; span: { startLine: number; endLine: number } }[],
  line: number,
): string | null {
  let best: { q: string; size: number } | null = null;
  for (const symbol of symbols) {
    if (line < symbol.span.startLine || line > symbol.span.endLine) continue;
    const size = symbol.span.endLine - symbol.span.startLine;
    if (best === null || size < best.size) best = { q: symbol.qualifiedName, size };
  }
  return best !== null ? best.q : null;
}

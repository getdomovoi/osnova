import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCacheDir, workspaceDirFor } from "../cache/cache.js";
import { workspaceIdentity } from "../index/workspace.js";
import type { LanguageId, OsnovaIndex, OsnovaSymbol } from "../types.js";
import { isRecord, LspClient, lspSessionCeilings } from "./client.js";
import { protocolLanguages, serverLocations, sourcePath } from "./enrichment.js";
import type { LspLocation, LspPosition } from "./types.js";

/** A language server named on the command line that starts `osnova mcp`; Osnova never reads one from stored configuration. */
export interface LspServerLaunch {
  readonly executable: string;
  readonly args?: readonly string[] | undefined;
  readonly languages: readonly LanguageId[];
  readonly requestTimeoutMs?: number | undefined;
}

export type LspReferencesAnswer =
  | { readonly status: "complete" | "partial"; readonly locations: readonly LspLocation[]; readonly queried: LspPosition; readonly filesGiven: number; readonly filesEligible: number; readonly loading: boolean }
  | { readonly status: "unavailable"; readonly code: string };

// A server finds references only in the projects it has loaded, so a session opens every indexed file in its
// languages, within the same file and byte limits as the enrichment sidecar.
export const lspSessionDefaults = Object.freeze({ requestTimeoutMs: 10_000, maxLocations: 4_096, maxOpenFiles: 4_096, maxOpenBytes: 67_108_864, settleIntervalMs: 200, settleAttempts: 25 });

// A tool that asks about several symbols in one call asks about this many at most, all under one request timeout.
export const lspSymbolsPerCall = 8;

export interface LspSymbolAnswers {
  readonly answers: readonly { readonly symbol: OsnovaSymbol; readonly answer: LspReferencesAnswer }[];
  readonly overCap: number;
  readonly pastDeadline: number;
  readonly afterFailure: number;
}

// One request in the session's queue. A caller with a deadline stops waiting at it; a request not sent by then is
// marked abandoned and skipped when its turn comes, leaving the server and the other requests untouched.
interface Turn { readonly until: number | undefined; sent: boolean; abandoned: boolean }

// What a turn hands its caller, and what the queue waits for before the next turn: the shutdown of a session the
// turn ended. An answer of undefined means the request was not sent before the caller's deadline.
interface Ran { readonly answer: LspReferencesAnswer | undefined; readonly release?: Promise<void> | undefined }

function errorCode(error: unknown): string {
  return error instanceof Error && /^[a-z0-9-]{1,64}$/.test(error.message) ? error.message : "request-failed";
}

/** The zero-based UTF-16 position of a symbol's name in its declaration, searched from the first line of its span. */
export function namePosition(text: string, symbol: OsnovaSymbol): LspPosition | undefined {
  const lines = text.split(/\r\n|\r|\n/);
  const escaped = symbol.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`, "u");
  for (let line = symbol.span.startLine - 1; line < Math.min(symbol.span.endLine, symbol.span.startLine + 8); line += 1) {
    const match = pattern.exec(lines[line] ?? "");
    if (match) return { line, character: match.index };
  }
  return undefined;
}

/**
 * One language-server session for the life of an MCP server. It starts on the first request, and starts again when
 * the index generation changes (so no answer comes from sources the server read before an edit) or after a failure.
 * Requests run one at a time.
 */
export class LspReferenceSession {
  private client: LspClient | undefined;
  private capabilities: Record<string, unknown> = {};
  private generation: string | undefined;
  private readonly opened = new Set<string>();
  private filesEligible = 0;
  // A server still loading projects answers only part of the references. A new session repeats each request until two
  // answers agree; a settled one still repeats once and falls back to that loop when the two differ, because a later
  // symbol may sit in a project the first one did not need.
  private settled = false;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  // Shutdowns still running, so close can wait for one that a failed request or a restart began.
  private readonly stopping = new Set<Promise<void>>();
  private readonly root: string;

  constructor(root: string, private readonly launch: LspServerLaunch, private readonly cacheDir: string | undefined) {
    this.root = workspaceIdentity(root);
  }

  handles(language: string): boolean {
    return this.launch.languages.includes(language as LanguageId);
  }

  references(index: OsnovaIndex, generation: string, symbol: OsnovaSymbol, until?: number): Promise<LspReferencesAnswer> {
    return this.enqueue(index, generation, symbol, until).then((answer) => answer ?? { status: "unavailable", code: "deadline" });
  }

  // With a deadline, the caller's wait ends at it however long the requests ahead take. Without one, the request's
  // timeout starts when its turn comes, after any start-up.
  private enqueue(index: OsnovaIndex, generation: string, symbol: OsnovaSymbol, until: number | undefined): Promise<LspReferencesAnswer | undefined> {
    const turn: Turn = { until, sent: false, abandoned: false };
    const ran = this.queue.then(() => this.run(index, generation, symbol, turn));
    this.queue = ran.then((result) => result.release, () => undefined);
    const answer = ran.then((result) => result.answer);
    if (until === undefined) return answer;
    let timer: NodeJS.Timeout | undefined;
    // A request already sent is bounded by the deadline itself, so its answer, or its cancellation, is awaited.
    const expired = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => { if (!turn.sent) { turn.abandoned = true; resolve(undefined); } }, Math.max(0, until - Date.now()));
    });
    return Promise.race([answer, expired]).finally(() => clearTimeout(timer));
  }

  /**
   * References for up to `cap` symbols, in the order given, under one deadline for the whole call. A symbol left when
   * the deadline has passed, or after a failed request, is counted rather than asked, so one call never restarts a
   * failing server more than once.
   *
   * The deadline starts when the call does and bounds everything the call waits for: the requests queued ahead of it,
   * the shutdown of a server from an older generation, the start-up of a new one, and its own requests. Start-up and
   * shutdown are not cut short at the deadline: a start-up runs to the initialize timeout, so the next call finds the
   * server running, and a shutdown runs to the shutdown limits, holding the queue but not this caller. A symbol whose
   * references request was not sent before the deadline is counted past the deadline, not as an answer.
   */
  async referencesEach(index: OsnovaIndex, generation: string, symbols: readonly OsnovaSymbol[], cap: number = lspSymbolsPerCall): Promise<LspSymbolAnswers> {
    const deadline = Date.now() + (this.launch.requestTimeoutMs ?? lspSessionDefaults.requestTimeoutMs);
    const answers: { symbol: OsnovaSymbol; answer: LspReferencesAnswer }[] = [];
    let pastDeadline = 0;
    let afterFailure = 0;
    let failed = false;
    for (const symbol of symbols.slice(0, cap)) {
      if (Date.now() >= deadline) { pastDeadline += 1; continue; }
      if (failed) { afterFailure += 1; continue; }
      const answer = await this.enqueue(index, generation, symbol, deadline);
      if (answer === undefined) { pastDeadline += 1; continue; }
      answers.push({ symbol, answer });
      if (answer.status === "unavailable" && answer.code !== "name-not-found") failed = true;
    }
    return { answers, overCap: Math.max(0, symbols.length - cap), pastDeadline, afterFailure };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stop();
    await Promise.all([...this.stopping]);
  }

  private async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.opened.clear();
    if (client === undefined) return;
    const stopped = client.close();
    this.stopping.add(stopped);
    try { await stopped; } finally { this.stopping.delete(stopped); }
  }

  private async start(index: OsnovaIndex, generation: string): Promise<LspClient> {
    await this.stop();
    const home = path.join(workspaceDirFor(path.resolve(resolveCacheDir(this.cacheDir)), this.root), "lsp", "session");
    await fs.mkdir(home, { recursive: true });
    if (this.closed) throw new Error("client-closed");
    const client: LspClient = new LspClient(
      { id: "mcp", executable: this.launch.executable, args: this.launch.args ?? [], workspace: this.root, languages: this.launch.languages },
      home,
      { requestTimeoutMs: this.launch.requestTimeoutMs ?? lspSessionDefaults.requestTimeoutMs, sessionTimeoutMs: lspSessionCeilings.sessionTimeoutMs, maxRequests: lspSessionCeilings.maxRequests, maxSessionBytes: lspSessionCeilings.maxSessionBytes, maxMessages: lspSessionCeilings.maxMessages, maxMessageBytes: lspSessionCeilings.maxMessageBytes, shutdownTimeoutMs: lspSessionCeilings.shutdownTimeoutMs },
      lspSessionCeilings,
    );
    // Held before initialize, so a close that lands during start-up stops this server too.
    this.client = client;
    this.generation = undefined;
    this.settled = false;
    this.capabilities = await client.initialize();
    if (this.closed || this.client !== client) { await client.close(); throw new Error("client-closed"); }
    this.generation = generation;
    const eligible = [...index.files.values()].filter((card) => this.handles(card.language)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.filesEligible = eligible.length;
    let bytes = 0;
    for (const card of eligible) {
      const size = Buffer.byteLength(card.text);
      if (this.opened.size >= lspSessionDefaults.maxOpenFiles || bytes + size > lspSessionDefaults.maxOpenBytes) break;
      this.open(client, index, card.path);
      bytes += size;
    }
    return client;
  }

  private open(client: LspClient, index: OsnovaIndex, file: string): void {
    const card = index.files.get(file);
    if (card === undefined) return;
    client.notify("textDocument/didOpen", { textDocument: { uri: pathToFileURL(sourcePath(index.root, card.path)).href, languageId: protocolLanguages[card.language as LanguageId], version: 1, text: card.text } });
    this.opened.add(card.path);
  }

  private async run(index: OsnovaIndex, generation: string, symbol: OsnovaSymbol, turn: Turn): Promise<Ran> {
    const { until } = turn;
    if (this.closed) return { answer: { status: "unavailable", code: "client-closed" } };
    if (turn.abandoned || (until !== undefined && Date.now() >= until)) return { answer: undefined };
    const card = index.files.get(symbol.file);
    if (card === undefined || !this.handles(card.language)) return { answer: { status: "unavailable", code: "no-server" } };
    const position = namePosition(card.text, symbol);
    if (position === undefined) return { answer: { status: "unavailable", code: "name-not-found" } };
    try {
      const client = this.client !== undefined && this.generation === generation ? this.client : await this.start(index, generation);
      // A deadline that passed during start-up leaves the request unsent rather than sent only to be cancelled, which
      // would end the session for the requests behind it.
      if (turn.abandoned || (until !== undefined && Date.now() >= until)) { turn.abandoned = true; return { answer: undefined }; }
      if (this.capabilities.referencesProvider !== true && !isRecord(this.capabilities.referencesProvider)) return { answer: { status: "unavailable", code: "method-unavailable" } };
      turn.sent = true;
      const uri = pathToFileURL(sourcePath(index.root, card.path)).href;
      if (!this.opened.has(card.path)) this.open(client, index, card.path);
      // A caller asking about several symbols passes its own deadline, shared by all of them.
      const deadline = until ?? Date.now() + (this.launch.requestTimeoutMs ?? lspSessionDefaults.requestTimeoutMs);
      const ask = async (signal?: AbortSignal) => serverLocations(await client.request("textDocument/references", { textDocument: { uri }, position, context: { includeDeclaration: true } }, signal), index, lspSessionDefaults.maxLocations);
      const same = (a: ReturnType<typeof serverLocations>, b: ReturnType<typeof serverLocations>): boolean => a.partial === b.partial && JSON.stringify(a.locations) === JSON.stringify(b.locations);
      // Every request after the first runs against the one deadline, so a slow server cannot hold the answer past it.
      const bounded = async (): Promise<ReturnType<typeof serverLocations> | undefined> => {
        try { return await ask(AbortSignal.timeout(Math.max(1, deadline - Date.now()))); }
        catch (error) { if (error instanceof Error && error.message === "cancelled") return undefined; throw error; }
      };
      let parsed = await ask(AbortSignal.timeout(Math.max(1, deadline - Date.now())));
      let loading = false;
      if (this.settled) {
        const again = await bounded();
        if (again === undefined) loading = true;
        else { if (!same(again, parsed)) this.settled = false; parsed = again; }
      }
      if (!this.settled && !loading) {
        loading = true;
        // Every repeat is cut off at the deadline, so a slow server cannot hold the answer past the request timeout.
        for (let attempt = 0; attempt < lspSessionDefaults.settleAttempts && deadline - Date.now() > lspSessionDefaults.settleIntervalMs; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, lspSessionDefaults.settleIntervalMs));
          const next = await bounded();
          if (next === undefined) break;
          const agreed = same(next, parsed);
          parsed = next;
          if (agreed) { loading = false; this.settled = true; break; }
        }
      }
      return { answer: { status: parsed.partial ? "partial" : "complete", locations: parsed.locations, queried: position, filesGiven: this.opened.size, filesEligible: this.filesEligible, loading } };
    } catch (error) {
      // Any failure ends this session; the next request starts a new one once the shutdown ends, but this caller has
      // its answer at once.
      const release = this.stop().catch(() => undefined);
      return { answer: { status: "unavailable", code: until !== undefined && Date.now() >= until && errorCode(error) === "cancelled" ? "deadline" : errorCode(error) }, release };
    }
  }
}

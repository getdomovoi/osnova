import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LspLaunchSpec, LspLimits } from "./types.js";

export const lspLimits: Readonly<LspLimits> = Object.freeze({
  requestTimeoutMs: 2_000,
  sessionTimeoutMs: 30_000,
  shutdownTimeoutMs: 250,
  maxRequests: 128,
  maxPending: 8,
  maxMessageBytes: 1_048_576,
  maxSessionBytes: 16_777_216,
  maxMessages: 4_096,
});

export function resolveLspLimits(overrides: Partial<LspLimits> = {}): LspLimits {
  const limits = { ...lspLimits };
  for (const key of Object.keys(overrides) as (keyof LspLimits)[]) {
    const value = overrides[key];
    if (!Object.hasOwn(lspLimits, key) || value === undefined || !Number.isSafeInteger(value) || value < 1 || value > lspLimits[key]) throw new Error("invalid-lsp-limit");
    limits[key] = value;
  }
  return limits;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

export class LspClient {
  readonly limits: LspLimits;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 0;
  private requests = 0;
  private receivedBytes = 0;
  private sentBytes = 0;
  private messages = 0;
  private failure: Error | undefined;
  private initialized = false;
  private closing: Promise<void> | undefined;
  private readonly sessionTimer: NodeJS.Timeout;
  private readonly exited: Promise<void>;
  private ended = false;
  private readonly spec: LspLaunchSpec;

  constructor(spec: LspLaunchSpec, cacheDirectory: string, limits: Partial<LspLimits> = {}) {
    if (!path.isAbsolute(spec.executable) || !path.isAbsolute(spec.workspace) || !path.isAbsolute(cacheDirectory)) throw new Error("absolute-launch-path-required");
    this.spec = spec;
    this.limits = resolveLspLimits(limits);
    this.child = spawn(spec.executable, [...(spec.args ?? [])], {
      cwd: cacheDirectory,
      shell: false,
      windowsHide: true,
      env: {
        HOME: cacheDirectory,
        USERPROFILE: cacheDirectory,
        TMPDIR: cacheDirectory,
        TMP: cacheDirectory,
        TEMP: cacheDirectory,
        XDG_CACHE_HOME: cacheDirectory,
        XDG_CONFIG_HOME: cacheDirectory,
        XDG_DATA_HOME: cacheDirectory,
        ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      },
      stdio: "pipe",
    });
    this.exited = new Promise((resolve) => {
      this.child.once("close", () => {
        this.ended = true;
        this.fail(new Error("server-exited"));
        resolve();
      });
    });
    this.child.on("error", () => this.fail(new Error("server-unavailable")));
    this.child.stdin.on("error", () => this.fail(new Error("transport-error")));
    this.child.stdout.on("error", () => this.fail(new Error("transport-error")));
    this.child.stderr.on("error", () => this.fail(new Error("transport-error")));
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.receivedBytes += chunk.length;
      if (this.receivedBytes > this.limits.maxSessionBytes) this.fail(new Error("session-byte-limit"));
    });
    this.sessionTimer = setTimeout(() => this.fail(new Error("session-timeout")), this.limits.sessionTimeoutMs);
  }

  async initialize(signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      const result = await this.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(this.spec.workspace).href,
        workspaceFolders: [{ uri: pathToFileURL(this.spec.workspace).href, name: path.basename(this.spec.workspace) }],
        capabilities: { general: { positionEncodings: ["utf-16"] }, workspace: { applyEdit: false }, textDocument: { definition: { linkSupport: true } } },
      }, signal);
      if (!isRecord(result) || !isRecord(result.capabilities)) throw new Error("invalid-initialize");
      if (result.capabilities.positionEncoding !== undefined && result.capabilities.positionEncoding !== "utf-16") throw new Error("unsupported-position-encoding");
      this.notify("initialized", {});
      this.initialized = true;
      return result.capabilities;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.sendRequest(method, params, signal, false);
  }

  private async sendRequest(method: string, params: unknown, signal: AbortSignal | undefined, shutdown: boolean): Promise<unknown> {
    if (this.failure) throw this.failure;
    if (signal?.aborted) throw new Error("cancelled");
    if (!shutdown && this.closing) throw new Error("client-closed");
    if (!shutdown && this.requests >= this.limits.maxRequests) throw new Error("request-limit");
    if (this.pending.size >= this.limits.maxPending) throw new Error("pending-limit");
    this.requests += 1;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const cancel = (code: string) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        try { this.notify("$/cancelRequest", { id }); } catch (error) { this.fail(error instanceof Error ? error : new Error("transport-error")); }
        reject(new Error(code));
      };
      const abort = () => cancel("cancelled");
      const timer = setTimeout(() => cancel("request-timeout"), shutdown ? this.limits.shutdownTimeoutMs : this.limits.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } });
      signal?.addEventListener("abort", abort, { once: true });
      try { this.send({ jsonrpc: "2.0", id, method, params }); } catch (error) {
        this.pending.get(id)?.cleanup();
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("transport-error"));
      }
    });
  }

  private send(message: unknown): void {
    if (this.failure) throw this.failure;
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > this.limits.maxMessageBytes) throw new Error("message-byte-limit");
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
    if (this.sentBytes + frame.length > this.limits.maxSessionBytes || this.child.stdin.writableLength + frame.length > this.limits.maxSessionBytes) throw new Error("session-byte-limit");
    this.sentBytes += frame.length;
    this.child.stdin.write(frame);
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return;
    this.receivedBytes += chunk.length;
    if (this.receivedBytes > this.limits.maxSessionBytes) return this.fail(new Error("session-byte-limit"));
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length > 0) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (this.buffer.length > 8_192) throw new Error("header-byte-limit");
          return;
        }
        if (end > 8_192) throw new Error("header-byte-limit");
        const headers = this.buffer.subarray(0, end).toString("ascii").split("\r\n");
        const lengths = headers.filter((line) => /^content-length:/i.test(line));
        if (lengths.length !== 1 || !/^content-length: *[0-9]+ *$/i.test(lengths[0]!)) throw new Error("invalid-framing");
        const length = Number(lengths[0]!.split(":")[1]!.trim());
        if (!Number.isSafeInteger(length) || length < 1 || length > this.limits.maxMessageBytes) throw new Error("message-byte-limit");
        if (this.buffer.length < end + 4 + length) return;
        const body = this.buffer.subarray(end + 4, end + 4 + length);
        this.buffer = this.buffer.subarray(end + 4 + length);
        let message: unknown;
        try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown; }
        catch { throw new Error("invalid-json"); }
        if (!isRecord(message) || message.jsonrpc !== "2.0") throw new Error("invalid-rpc");
        if (++this.messages > this.limits.maxMessages) throw new Error("message-limit");
        if (typeof message.method === "string") {
          if (typeof message.id === "string" || typeof message.id === "number") this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client does not support server requests" } });
          continue;
        }
        if (typeof message.id !== "number") throw new Error("invalid-rpc");
        if (("result" in message) === ("error" in message)) throw new Error("invalid-rpc");
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        pending.cleanup();
        if ("error" in message) pending.reject(new Error("rpc-error"));
        else pending.resolve(message.result);
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error("invalid-rpc")); }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    clearTimeout(this.sessionTimer);
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
    if (!this.ended) this.child.kill("SIGKILL");
  }

  close(): Promise<void> {
    this.closing ??= this.stop();
    return this.closing;
  }

  private async stop(): Promise<void> {
    if (this.initialized && !this.failure) {
      await this.sendRequest("shutdown", null, undefined, true).catch(() => {});
      try { this.notify("exit", undefined); } catch (error) { this.fail(error instanceof Error ? error : new Error("transport-error")); }
    }
    this.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, this.limits.shutdownTimeoutMs); })]);
    clearTimeout(timer);
    if (!this.ended) this.fail(new Error("client-closed"));
    clearTimeout(this.sessionTimer);
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    await Promise.race([this.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, this.limits.shutdownTimeoutMs); })]);
    clearTimeout(timer);
  }
}

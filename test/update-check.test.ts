import { describe, expect, it } from "vitest";
import { formatUpdateCheck, isNewerVersion, updateCheck, updateCheckRegistryUrl } from "../src/cli/update-check.js";

function registry(version: unknown, init?: { status?: number }): typeof globalThis.fetch {
  return (async () => new Response(JSON.stringify({ version }), { status: init?.status ?? 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
}

describe("isNewerVersion", () => {
  it("orders releases by numeric part, not by string", () => {
    expect(isNewerVersion("0.6.10", "0.6.9")).toBe(true);
    expect(isNewerVersion("0.7.0", "0.6.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.6.3", "0.6.3")).toBe(false);
    expect(isNewerVersion("0.6.2", "0.6.3")).toBe(false);
  });

  it("sorts a prerelease below its own release", () => {
    expect(isNewerVersion("0.7.0-rc.1", "0.7.0")).toBe(false);
    expect(isNewerVersion("0.7.0", "0.7.0-rc.1")).toBe(true);
  });
});

describe("updateCheck", () => {
  it("reports an outdated install", async () => {
    const result = await updateCheck({ current: "0.6.2", fetch: registry("0.6.3") });
    expect(result).toEqual({ name: "@getdomovoi/osnova", current: "0.6.2", latest: "0.6.3", outdated: true });
    expect(formatUpdateCheck(result)).toContain("npm install -g @getdomovoi/osnova@0.6.3");
  });

  it("reports a current install", async () => {
    const result = await updateCheck({ current: "0.6.3", fetch: registry("0.6.3") });
    expect(result.outdated).toBe(false);
    expect(formatUpdateCheck(result)).toBe("@getdomovoi/osnova 0.6.3 is up to date");
  });

  it("asks the npm registry and nothing else", async () => {
    const seen: string[] = [];
    const spy = (async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ version: "0.6.3" }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await updateCheck({ current: "0.6.3", fetch: spy });
    expect(seen).toEqual([updateCheckRegistryUrl]);
  });

  it("names the registry when the request fails", async () => {
    const failing = (async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    }) as unknown as typeof globalThis.fetch;
    await expect(updateCheck({ current: "0.6.3", fetch: failing })).rejects.toThrow(/could not reach the npm registry/);
  });

  it("refuses an answer with no version field", async () => {
    await expect(updateCheck({ current: "0.6.3", fetch: registry(undefined) })).rejects.toThrow(/no version field/);
  });

  it("refuses a registry error status", async () => {
    await expect(updateCheck({ current: "0.6.3", fetch: registry("0.6.3", { status: 503 }) })).rejects.toThrow(/answered 503/);
  });
});

describe("updateCheck bounds the registry answer", () => {
  it("gives up on a body that stalls after the headers arrive", async () => {
    const stalled = (async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 })) as unknown as typeof globalThis.fetch;
    const started = performance.now();
    const outcome = await Promise.race([
      updateCheck({ current: "0.6.3", fetch: stalled, timeoutMs: 200 }).then(() => "resolved", (error: unknown) => (error as Error).message),
      new Promise<string>((resolve) => setTimeout(() => resolve("still hanging"), 3_000)),
    ]);
    expect(outcome).toMatch(/could not read the npm registry answer/);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("refuses an answer larger than one mebibyte", async () => {
    const chunk = new TextEncoder().encode(" ".repeat(65_536));
    let sent = 0;
    const endless = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { sent += chunk.byteLength; controller.enqueue(chunk); },
    }), { status: 200 })) as unknown as typeof globalThis.fetch;
    await expect(updateCheck({ current: "0.6.3", fetch: endless, timeoutMs: 5_000 })).rejects.toThrow(/larger than 1048576 bytes/);
    expect(sent).toBeLessThanOrEqual(2 * 1_048_576);
  });
});

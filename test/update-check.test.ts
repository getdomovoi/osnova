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

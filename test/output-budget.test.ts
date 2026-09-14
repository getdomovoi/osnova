import { describe, expect, it } from "vitest";
import { boundText } from "../src/query/budget.js";
import { formatAsk } from "../src/query/format.js";
import { renderMapCard } from "../src/query/mapCard.js";
import { OsnovaIndexImpl } from "../src/index/indexImpl.js";

describe("text presentation budget", () => {
  it("preserves responses that already fit", () => {
    expect(boundText("small response", 256)).toBe("small response");
    expect(boundText("", 256)).toBe("");
    expect(boundText("a".repeat(256), 256)).toBe("a".repeat(256));
  });

  it("reports exact omitted code units within the requested cap", () => {
    const text = "x".repeat(20_000);
    const result = boundText(text, 512);
    expect(result.length).toBeLessThanOrEqual(512);
    const retained = result.indexOf("\n[output truncated:");
    expect(retained).toBeGreaterThan(0);
    expect(result).toContain(`${text.length - retained} UTF-16 code units omitted`);
    expect(result).toContain("before output clipping");
    expect(boundText(text, 512)).toBe(result);
  });

  it("does not split a surrogate pair at the clipping boundary", () => {
    const result = boundText("\u{1F680}".repeat(1000), 513);
    const retained = result.slice(0, result.indexOf("\n[output truncated:"));
    expect(retained.length % 2).toBe(0);
    expect(result.length).toBeLessThanOrEqual(513);
  });

  it.each([0, 255, -1, 512.5, NaN, Infinity])("rejects budgets unable to carry a complete notice: %s", (budget) => {
    expect(() => boundText("text", budget)).toThrow(RangeError);
  });

  it("discloses excerpts even when an internal span cap precedes output clipping", () => {
    const text = formatAsk({ filesSearched: 1, hits: [{
      file: "file.ts", line: 1, score: 1, excerpt: "line\n".repeat(399) + "line", excerptStartLine: 1,
      symbol: { name: "big", qualifiedName: "file.ts#big", kind: "function", file: "file.ts",
        signature: "function big()", span: { startLine: 1, endLine: 500, startCol: 0, endCol: 1 }, lineCount: 500 },
    }] });
    expect(text).toContain("excerpt: lines 1-400 of definition lines 1-500");
  });

  it.each([0, 1, 128, 256])("honors even tiny map-card caps: %s", async (maxCodeUnits) => {
    const index = new OsnovaIndexImpl("/fixture", new Map(), []);
    expect((await renderMapCard(index, { maxCodeUnits, staleCount: 0 })).length).toBeLessThanOrEqual(maxCodeUnits);
  });

  it.each([-1, 1.5, NaN, Infinity])("rejects invalid map-card caps: %s", async (maxCodeUnits) => {
    const index = new OsnovaIndexImpl("/fixture", new Map(), []);
    await expect(renderMapCard(index, { maxCodeUnits, staleCount: 0 })).rejects.toThrow(RangeError);
  });
});

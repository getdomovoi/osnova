import { describe, expect, it } from "vitest";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { skeleton } from "../src/query/skeleton.js";
import { callers } from "../src/query/callers.js";
import { renderMapCard } from "../src/query/mapCard.js";
import { maximumOsnovaMapCardCodeUnits } from "../src/types.js";

describe("self-hosting", () => {
  it("indexes the osnova source tree itself", async () => {
    const root = path.join(import.meta.dirname, "..");
    const index = await buildIndex(root);
    expect(index.files.has("src/query/mapCard.ts")).toBe(true);
    expect(index.files.has("src/extract/typescript.ts")).toBe(true);

    const cardSkeleton = skeleton(index, "src/query/mapCard.ts");
    const names = cardSkeleton.entries.map((e) => e.symbol.name);
    expect(names).toContain("renderMapCard");
    const render = cardSkeleton.entries.find((e) => e.symbol.name === "renderMapCard");
    expect(render?.signature).toContain("renderMapCard(");
    expect(render?.symbol.kind).toBe("function");
  }, 120_000);

  it("finds callers of renderMapCard with verified spans", async () => {
    const root = path.join(import.meta.dirname, "..");
    const index = await buildIndex(root);
    const target = index.symbols.get("src/query/mapCard.ts#renderMapCard");
    expect(target).toBeDefined();
    expect(target?.span.startLine).toBeGreaterThan(0);

    const result = callers(index, "src/query/mapCard.ts#renderMapCard");
    const callerFiles = result.hits.map((h) => h.file);
    expect(callerFiles).toContain("src/mcp/server.ts");
  }, 120_000);

  it("renders its own map card within the contract cap", async () => {
    const root = path.join(import.meta.dirname, "..");
    const index = await buildIndex(root);
    const card = await renderMapCard(index, { staleCount: 0 });
    expect(card.length).toBeLessThanOrEqual(maximumOsnovaMapCardCodeUnits);
    expect(card).toContain("osnova osnova");
  }, 120_000);
});

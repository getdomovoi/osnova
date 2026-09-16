import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildIndex } from "../src/index/build.js";
import { applyChanges, freshness } from "../src/index/incremental.js";
import { saveArtifact, serializeArtifact, serializeSections } from "../src/index/serialize.js";
import { previousTextFrom, serializeText } from "../src/index/textStore.js";
import { loadIndex } from "../src/api.js";
import type { OsnovaIndex } from "../src/types.js";

function copyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-determinism-"));
  fs.cpSync(path.join(import.meta.dirname, "fixtures", "sample-repo"), dir, { recursive: true });
  return dir;
}

describe("deterministic index", () => {
  it("produces byte-identical artifacts across rebuilds", async () => {
    const dir = copyFixture();
    try {
      const a = serializeArtifact(await buildIndex(dir));
      const b = serializeArtifact(await buildIndex(dir));
      expect(a.equals(b)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps edges sorted and deduplicated", async () => {
    const dir = copyFixture();
    try {
      const index = await buildIndex(dir);
      const key = (e: OsnovaIndex["edges"][number]): [string, number, string, string, string, string, string] => [
        e.fromFile,
        e.line,
        e.kind,
        e.toName,
        e.toSymbol ?? "",
        e.toFile ?? "",
        e.fromSymbol,
      ];
      const less = (a: ReturnType<typeof key>, b: ReturnType<typeof key>): boolean => {
        for (let i = 0; i < a.length; i += 1) {
          const av = a[i] as string | number;
          const bv = b[i] as string | number;
          if (av !== bv) return av < bv;
        }
        return false;
      };
      for (let i = 1; i < index.edges.length; i += 1) {
        const prev = key(index.edges[i - 1] as OsnovaIndex["edges"][number]);
        const edge = key(index.edges[i] as OsnovaIndex["edges"][number]);
        expect(less(prev, edge), `edge ${i}`).toBe(true);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("incremental equals full", () => {
  it("randomized edit sequences converge to identical artifacts", async () => {
    const dir = copyFixture();
    const incrementalCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-determinism-inc-"));
    const freshCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-determinism-fresh-"));
    try {
      let seed = 0x5eed1234;
      const rand = (n: number): number => {
        seed = (seed * 1103515245 + 12345) >>> 0;
        return Math.floor((seed / 0xffffffff) * n);
      };

      let index: OsnovaIndex = await buildIndex(dir);
      for (let step = 0; step < 12; step += 1) {
        const op = rand(4);
        if (op === 0) {
          const file = path.join(dir, "src/util.ts");
          fs.appendFileSync(file, `\nexport function injected${step}(v: number): number { return v + ${step}; }\n`);
        } else if (op === 1) {
          const file = path.join(dir, "src/server.py");
          fs.appendFileSync(file, `\ndef injected_${step}(value):\n    return value + ${step}\n`);
        } else if (op === 2) {
          const name = step % 2 === 0 ? "src/app.ts" : "src/main.go";
          fs.rmSync(path.join(dir, name), { force: true });
        } else {
          const name = step % 2 === 0 ? `src/new${step}.ts` : `src/new${step}.py`;
          fs.writeFileSync(
            path.join(dir, name),
            step % 2 === 0
              ? `export function fresh${step}(): number { return ${step}; }\n`
              : `def fresh_${step}():\n    return ${step}\n`,
          );
        }

        const report = await freshness(index, dir);
        index = await applyChanges(index, dir, [...report.added, ...report.changed, ...report.deleted]);
        const incremental = serializeArtifact(index);
        const full = serializeArtifact(await buildIndex(dir));
        expect(incremental.equals(full), `step ${step} op ${op}`).toBe(true);
        const incrementalText = serializeText(index).bytes;
        const fullText = serializeText(await buildIndex(dir)).bytes;
        expect(incrementalText.equals(fullText)).toBe(true);
        const incrementalEdges = serializeSections(index).edges.bytes;
        const fullEdges = serializeSections(await buildIndex(dir)).edges.bytes;
        expect(incrementalEdges.equals(fullEdges)).toBe(true);

        const publishedIncrementalPath = await saveArtifact(index, incrementalCacheDir);
        const publishedFreshPath = await saveArtifact(await buildIndex(dir), freshCacheDir);
        const publishedIncrementalDir = path.dirname(publishedIncrementalPath);
        const publishedFreshDir = path.dirname(publishedFreshPath);
        const publishedIncrementalText = fs.readFileSync(path.join(publishedIncrementalDir, "text.bin"));
        const publishedFreshText = fs.readFileSync(path.join(publishedFreshDir, "text.bin"));
        expect(publishedIncrementalText.equals(publishedFreshText), `step ${step} published text`).toBe(true);
        const publishedIncrementalEdges = fs.readFileSync(path.join(publishedIncrementalDir, "edges.json"));
        const publishedFreshEdges = fs.readFileSync(path.join(publishedFreshDir, "edges.json"));
        expect(publishedIncrementalEdges.equals(publishedFreshEdges), `step ${step} published edges`).toBe(true);
        const reloaded = await loadIndex(dir, { cacheDir: incrementalCacheDir });
        expect(reloaded, `step ${step} reload`).toBeDefined();
        index = reloaded!;
        expect(previousTextFrom(index), `step ${step} lazy text source`).toBeDefined();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(incrementalCacheDir, { recursive: true, force: true });
      fs.rmSync(freshCacheDir, { recursive: true, force: true });
    }
  });

  it("freshness detects added, changed, and deleted files", async () => {
    const dir = copyFixture();
    try {
      const index = await buildIndex(dir);
      const before = await freshness(index, dir);
      expect(before.added).toHaveLength(0);
      expect(before.changed).toHaveLength(0);
      expect(before.deleted).toHaveLength(0);

      fs.writeFileSync(path.join(dir, "src/util.ts"), "export function replaced(): number { return 0; }\n");
      fs.writeFileSync(path.join(dir, "src/added.ts"), "export const x = 1;\n");
      fs.rmSync(path.join(dir, "src/app.ts"));

      const report = await freshness(index, dir);
      expect(report.changed).toEqual(["src/util.ts"]);
      expect(report.added).toEqual(["src/added.ts"]);
      expect(report.deleted).toEqual(["src/app.ts"]);

      const updated = await applyChanges(index, dir, [...report.added, ...report.changed, ...report.deleted]);
      expect(updated.files.has("src/added.ts")).toBe(true);
      expect(updated.files.has("src/app.ts")).toBe(false);
      expect(updated.symbols.has("src/util.ts#replaced")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

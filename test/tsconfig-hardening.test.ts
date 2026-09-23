import { describe, expect, it } from "vitest";
import { matchPaths } from "../src/index/tsconfig.js";

function referenceMatchPaths(paths: ReadonlyMap<string, readonly string[]>, spec: string): readonly string[] | "ambiguous" | undefined {
  const exact = paths.get(spec);
  if (exact !== undefined) return exact;
  let best: { prefix: number; targets: readonly string[]; filler: string; tie: boolean } | undefined;
  for (const [key, targets] of paths) {
    const star = key.indexOf("*");
    if (star < 0 || key.indexOf("*", star + 1) >= 0) continue;
    const prefix = key.slice(0, star), suffix = key.slice(star + 1);
    if (!spec.startsWith(prefix) || !spec.endsWith(suffix) || spec.length < prefix.length + suffix.length) continue;
    const filler = spec.slice(prefix.length, spec.length - suffix.length);
    if (best === undefined || prefix.length > best.prefix) best = { prefix: prefix.length, targets, filler, tie: false };
    else if (prefix.length === best.prefix) best.tie = true;
  }
  if (best === undefined) return undefined;
  if (best.tie) return "ambiguous";
  return best.targets.map((target) => target.split("*").join(best.filler));
}

class CountingMap<K, V> extends Map<K, V> {
  walks = 0;
  override [Symbol.iterator](): MapIterator<[K, V]> { this.walks += 1; return super[Symbol.iterator](); }
  override entries(): MapIterator<[K, V]> { this.walks += 1; return super.entries(); }
  override keys(): MapIterator<K> { this.walks += 1; return super.keys(); }
  override values(): MapIterator<V> { this.walks += 1; return super.values(); }
  override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void { this.walks += 1; super.forEach(callback, thisArg); }
}

describe("matchPaths", () => {
  it("walks the paths map once per config, not once per specifier", () => {
    const paths = new CountingMap<string, readonly string[]>();
    for (let i = 0; i < 2000; i += 1) paths.set(`@m${i}/*`, [`lib/m${i}/*`]);
    for (let i = 0; i < 2000; i += 1) expect(matchPaths(paths, `@m${i}/x`)).toEqual([`lib/m${i}/x`]);
    expect(matchPaths(paths, "@none/x")).toBeUndefined();
    expect(paths.walks).toBeLessThanOrEqual(1);
  });

  it("agrees with the linear scan on exact keys, longest prefix, suffixes, overlap and ties", () => {
    let seed = 7;
    const next = (bound: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % bound; };
    const alphabet = ["a", "b", "/", ".", "ts"];
    const word = (length: number): string => Array.from({ length }, () => alphabet[next(alphabet.length)]).join("");
    for (let round = 0; round < 400; round += 1) {
      const paths = new Map<string, readonly string[]>();
      const keys = 1 + next(8);
      for (let k = 0; k < keys; k += 1) {
        const shape = next(6);
        const key = shape === 0 ? word(next(4)) : shape === 1 ? `${word(next(3))}*${word(next(2))}*` : `${word(next(4))}*${word(next(3))}`;
        paths.set(key, [`t${k}/*`, `u${k}`]);
      }
      for (let s = 0; s < 20; s += 1) {
        const spec = word(next(7));
        expect(matchPaths(paths, spec), `${JSON.stringify([...paths.keys()])} ${JSON.stringify(spec)}`).toEqual(referenceMatchPaths(paths, spec));
      }
    }
  });
});

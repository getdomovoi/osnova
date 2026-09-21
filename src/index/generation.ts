import { createHash } from "node:crypto";
import type { OsnovaIndex } from "../types.js";

const generations = new WeakMap<OsnovaIndex, string>();

export function knownIndexGeneration(index: OsnovaIndex): string | undefined {
  return generations.get(index);
}

export function rememberIndexGeneration(index: OsnovaIndex, serialized: Buffer | string): string {
  const generation = createHash("sha256").update(serialized).digest("hex");
  generations.set(index, generation);
  return generation;
}

export function bindIndexGeneration(index: OsnovaIndex, generation: string): string {
  generations.set(index, generation);
  return generation;
}

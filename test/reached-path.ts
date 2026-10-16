import { readlinkSync } from "node:fs";
import path from "node:path";

// The path a file system call reaches. A refresh reaches its cache through a descriptor of the cache directory where
// the platform allows, as /proc/self/fd/<n>/..., so such a path is named by the directory that descriptor refers to.
export function reachedPath(file: string): string {
  const bound = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(file);
  return bound === null ? path.resolve(file) : `${readlinkSync(`/proc/self/fd/${bound[1]!}`)}${bound[2] ?? ""}`;
}

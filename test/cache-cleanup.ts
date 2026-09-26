import fs from "node:fs";

export default function setup(): () => void {
  const root = process.env.OSNOVA_VITEST_CACHE_ROOT;
  return () => {
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  };
}

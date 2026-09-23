import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// The file-unreadable tests chmod a file to 0 and skip themselves as root, which chmod cannot stop.
if (["true", "1"].includes(process.env.CI ?? "") && process.getuid?.() === 0) {
  throw new Error("osnova: CI must not run the tests as root; the file-unreadable tests would be skipped");
}

export default defineConfig({
  test: {
    // Tests that index a temporary workspace without a cacheDir must not land in the user's
    // default cache, where the workspace cap would evict real repositories.
    env: { OSNOVA_CACHE_DIR: path.join(os.tmpdir(), "osnova-vitest-cache") },
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: "forks",
    sequence: { shuffle: true },
  },
});

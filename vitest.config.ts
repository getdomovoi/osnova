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
    // Test files build indexes on worker pools sized to the machine, so parallel forks only pay off with
    // cores to spare: on the 3-4 vCPU CI runners they slowed the suite (ubuntu 138s to 197s, windows 265s
    // to 408s with a property-test timeout), while on a 15-core laptop they cut 55s to 27s.
    poolOptions: { forks: { singleFork: os.availableParallelism() < 8 } },
  },
});

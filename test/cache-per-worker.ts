import path from "node:path";

// Runs before every test file; built from the run's root so a worker that runs several files keeps one folder.
const root = process.env.OSNOVA_VITEST_CACHE_ROOT;
if (root !== undefined) process.env.OSNOVA_CACHE_DIR = path.join(root, `worker-${process.env.VITEST_POOL_ID ?? process.pid}`);

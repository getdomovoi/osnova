import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
      index: "src/index.ts",
      cli: "src/cli/cli.ts",
      mcp: "src/mcp/server.ts",
      diagnostics: "src/diagnostics/index.ts",
      enrichment: "src/enrichment/index.ts",
      bin: "src/cli/bin.ts",
      extractWorker: "src/index/extractWorker.ts",
    },
    format: ["esm"],
    dts: true,
    target: "node22",
    platform: "node",
    sourcemap: true,
    clean: true,
    splitting: true,
});

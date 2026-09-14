import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      cli: "src/cli/cli.ts",
      mcp: "src/mcp/server.ts",
    },
    format: ["esm"],
    dts: true,
    target: "node22",
    platform: "node",
    sourcemap: true,
    clean: true,
    splitting: false,
    banner: {
      js: "// @getdomovoi/osnova",
    },
  },
  {
    entry: {
      bin: "src/cli/bin.ts",
    },
    format: ["esm"],
    target: "node22",
    platform: "node",
    sourcemap: false,
    clean: false,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);

// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "test/fixtures/**", ".claude/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["eslint.config.js", "tsup.config.ts", "vitest.config.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "error",
    },
  },
  {
    files: ["integrations/**/*.js"],
    languageOptions: { globals: { process: "readonly", setTimeout: "readonly", clearTimeout: "readonly", Buffer: "readonly" } },
  },
  {
    files: ["site/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { window: "readonly", document: "readonly", navigator: "readonly", fetch: "readonly", Element: "readonly", Node: "readonly", IntersectionObserver: "readonly" },
    },
  },
  {
    files: ["scripts/**/*.mjs", "benchmarks/oracle/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        performance: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        WebSocket: "readonly",
      },
    },
    rules: {
      "no-console": "off",
    },
  },
);

import { defineConfig } from "vitest/config";

/**
 * Root Vitest config for the whole repo. Test infrastructure was previously
 * nonexistent — this is the greenfield setup for the refactor. Pure-logic
 * suites run in the default node environment; canvas/DOM suites opt into
 * happy-dom per-file via `// @vitest-environment happy-dom`.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "packages/preview-engine/src/**/*.{test,spec}.ts",
      "apps/app/src/**/*.{test,spec}.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/main/**"],
  },
});

import { defineConfig } from "vitest/config";

/**
 * Root Vitest config for the whole repo. Pure-logic suites run in the default
 * node environment; the renderer suites draw onto a real Skia canvas supplied by
 * `@napi-rs/canvas`, so they assert on pixels rather than on recorded calls.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // `electron/` is compiled by a separate tsc pass that excludes tests, so a
    // suite can live next to main-process code without entering that build.
    include: [
      "apps/app/src/**/*.{test,spec}.ts",
      "electron/**/*.{test,spec}.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/main/**"],
  },
});

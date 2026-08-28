/**
 * One project per scale profile.
 *
 * Timeouts here are unusually large on purpose: the `full` profile renders
 * 18,000 frames of a twenty-clip timeline through a real FFmpeg, and the point
 * of the suite is that it survives that. A timeout tuned for a normal UI test
 * would report "flaky" for the exact condition being measured.
 *
 * `workers: 1` and `fullyParallel: false` are load bearing rather than
 * cautious. `electron/render/renderFrame.ts` keeps one module-level export
 * session, so a second concurrent export is refused with "An export is already
 * running" — and two Electron instances competing for GPU and decoders would
 * make every timing-sensitive assertion meaningless anyway.
 */

import { defineConfig } from "@playwright/test";
import path from "node:path";

// `__dirname`, not `import.meta.url`: Playwright transpiles this file to
// CommonJS (the root package.json declares no `"type": "module"`), and
// `import.meta` is a syntax error there. The `fixtures/*.mjs` scripts are real
// ESM run by node directly and do use `import.meta.url`.
const HERE = __dirname;

const MINUTE = 60_000;

export default defineConfig({
  testDir: path.join(HERE, "specs"),
  outputDir: path.join(HERE, ".out", "playwright"),

  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // A stress test that passes on retry has still told you something. Retrying
  // would hide it, and at these runtimes a retry is not cheap either.
  retries: 0,

  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(HERE, ".out", "report"), open: "never" }],
    ["json", { outputFile: path.join(HERE, ".out", "results.json") }],
  ],

  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "smoke",
      timeout: 10 * MINUTE,
      use: { actionTimeout: 30_000 },
      metadata: { profile: "smoke" },
    },
    {
      name: "full",
      // 18,000 frames. Measured throughput decides the real number; this is a
      // ceiling that lets a genuinely slow machine finish rather than a
      // prediction of how long it should take.
      timeout: 180 * MINUTE,
      use: { actionTimeout: 60_000 },
      metadata: { profile: "full" },
    },
    {
      name: "extreme",
      timeout: 480 * MINUTE,
      use: { actionTimeout: 120_000 },
      metadata: { profile: "extreme" },
    },
  ],
});

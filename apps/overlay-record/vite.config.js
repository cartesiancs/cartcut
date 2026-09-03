import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Required: the windows are opened with `loadFile`, so every asset URL has to
  // be relative. An absolute `/assets/...` resolves against the filesystem root.
  base: "",

  resolve: {
    alias: {
      // The recorder shares the editor's pure modules — capture sizing, the
      // bubble layout, the zoom planner, the settings schema. They live under
      // `apps/app/src/features/record/` rather than here because that is what
      // `vitest.config.ts` includes, and every one of them is arithmetic worth
      // pinning with a test. `packages/render` reaches the renderer the same
      // way and for the same reason.
      "@app": fileURLToPath(new URL("../app/src", import.meta.url)),
    },
  },

  build: {
    // Two windows, two entry points: a transparent always-on-top viewfinder,
    // and a hidden window that does the capturing. `electron/lib/window.ts`
    // explains why they are separate.
    rollupOptions: {
      input: {
        overlay: fileURLToPath(new URL("./overlay.html", import.meta.url)),
        engine: fileURLToPath(new URL("./engine.html", import.meta.url)),
      },
    },
  },
});

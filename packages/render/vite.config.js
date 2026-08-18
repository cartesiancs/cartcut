import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  base: "",
  resolve: {
    alias: {
      // Unified rendering engine (shared with apps/app). Consumed as TS source;
      // Vite/esbuild transpiles it.
      "@nugget/preview-engine": fileURLToPath(
        new URL("../preview-engine/src", import.meta.url),
      ),
    },
  },
});

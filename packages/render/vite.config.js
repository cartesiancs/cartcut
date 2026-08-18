import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  base: "",
  resolve: {
    alias: {
      // The offscreen render window composites with the same renderer as the
      // editor and the in-app export, so it reads that source directly.
      "@app": fileURLToPath(new URL("../../apps/app/src", import.meta.url)),
    },
  },
});

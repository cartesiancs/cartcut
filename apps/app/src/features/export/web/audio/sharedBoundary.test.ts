import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The renderer bundles these two main-process files through `shared.ts`, so
 * what they import is the renderer's problem. Both import nothing today; this
 * keeps it that way.
 */
const ROOT = path.resolve(__dirname, "../../../../../../../electron/render");
const SHARED_FILES = ["speedStretch.ts", "audioEnvelope.ts"];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the main-process audio files the browser export bundles", () => {
  for (const file of SHARED_FILES) {
    it(file + " imports nothing", () => {
      const source = stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"));
      expect(/^\s*(?:import|export)\b[^;]*\bfrom\s+["']/m.test(source)).toBe(false);
      expect(/^\s*import\s+["']/m.test(source)).toBe(false);
    });

    it(file + " names no node builtin and no electron API", () => {
      const source = stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"));
      for (const forbidden of ["require(", "node:", 'from "electron"', "process.", "__dirname", "Buffer"]) {
        expect([file, forbidden, source.includes(forbidden)]).toEqual([file, forbidden, false]);
      }
    });
  }
});

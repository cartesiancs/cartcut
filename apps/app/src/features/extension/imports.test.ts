import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The wall, as a test.
 *
 * The whole promise of this subsystem is that extensions cannot invade the
 * app, and half of that promise is about the import graph: if any part of the
 * editor started reaching into `features/extension/`, the coupling would grow
 * quietly until "remove extensions and the editor is unchanged" stopped being
 * true. So the list of files allowed to import it is written down here, and
 * adding to it is a deliberate line in a diff rather than an import somebody
 * added while doing something else.
 *
 * The other half is the reverse direction, and it is checked too: a file under
 * `features/extension/` that reached into, say, the preview canvas would be a
 * back door into the editor's internals with no owner.
 */

const SRC = path.resolve(__dirname, "../..");
const FEATURE = "features/extension/";

/**
 * Where the editor is allowed to touch the extension system.
 *
 * Each of these is a seam with a reason:
 *
 * - `index.ts` starts it, for effect, exactly as it starts the agent bridge.
 * - `Control.ts` renders contributed tabs, panels and inspector sections.
 * - `App.ts` mounts the status strip.
 * - `elementTimelineCanvas.ts` holds the keybinding and context-menu seams.
 * - `menuCommands.ts` runs a contributed command from the app menu.
 * - the four project files carry extension data through save, load, autosave
 *   and the dirty digest.
 * - `commit.ts` and `context.ts` are the batch seam.
 * - `serialize.ts`'s caller shows an extension its own data.
 * - `commands/animation.ts` resolves a preset an extension contributed.
 * - `animationPresetBrowser.ts` shows contributed presets as tiles.
 * - `presetRegistry` is reached the other way round, so it is not here.
 */
const ALLOWED_IMPORTERS = new Set([
  "index.ts",
  "App.ts",
  "ui/control/Control.ts",
  "ui/control/ControlExtension.ts",
  "features/element/elementTimelineCanvas.ts",
  "features/editor/menuCommands.ts",
  "features/agent/commit.ts",
  "features/agent/context.ts",
  "features/agent/commands/read.ts",
  "features/agent/commands/animation.ts",
  "features/option/animationPresetBrowser.ts",
  "functions/project.ts",
  "features/project/projectDirty.ts",
  "features/project/autosaveBridge.ts",
  "features/project/recoverAutosave.ts",
]);

/**
 * What `features/extension/` may import.
 *
 * Prefixes, because the point is which subsystems it may know about, not which
 * files. It may reach the agent command layer (that is how it edits), the
 * window system (that is how it shows a panel), the pure `timeline/` and
 * `animation/` layers (that is what a contributed preset is made of), the
 * stores it publishes events from, and the shared protocol. It may not reach
 * the renderer, the preview, the timeline canvas or the export pipeline.
 */
const ALLOWED_IMPORTS = [
  "../agent/",
  "../window/",
  "../editor/",
  "../fx/presetRegistry",
  "../timeline/tracks",
  "../animation/",
  "../caption/previewLoop",
  "../renderer/testing",
  "../../states/",
  "../../@types/",
  "../../utils/",
  "../../functions/",
  "../../../../../electron/extension/",
  "./",
  "lit",
  "zustand",
  "node:",
  "vitest",
];

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, found);
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

function importsOf(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) != null) {
    found.push(match[1]);
  }
  const bare = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  while ((match = bare.exec(source)) != null) {
    found.push(match[1]);
  }
  return found;
}

describe("the extension import wall", () => {
  const files = walk(SRC).filter((file) => !file.endsWith(".test.ts"));

  it("is crossed only by the files that declare a seam", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const relative = path.relative(SRC, file).split(path.sep).join("/");
      if (relative.startsWith(FEATURE)) {
        continue;
      }
      const source = fs.readFileSync(file, "utf8");
      const reaches = importsOf(source).some(
        (specifier) => specifier.includes("/extension/") || specifier.includes("features/extension"),
      );
      if (reaches && !ALLOWED_IMPORTERS.has(relative)) {
        offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("does not reach into parts of the editor it has no business in", () => {
    const offenders: Array<{ file: string; specifier: string }> = [];

    for (const file of files) {
      const relative = path.relative(SRC, file).split(path.sep).join("/");
      if (!relative.startsWith(FEATURE)) {
        continue;
      }
      for (const specifier of importsOf(fs.readFileSync(file, "utf8"))) {
        const allowed = ALLOWED_IMPORTS.some((prefix) => specifier.startsWith(prefix));
        if (!allowed) {
          offenders.push({ file: relative, specifier });
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("names every seam that actually exists", () => {
    // The other direction: a name left in the allowlist after the seam was
    // removed would quietly re-open the door for the next file with that path.
    for (const allowed of ALLOWED_IMPORTERS) {
      expect([allowed, fs.existsSync(path.join(SRC, allowed))]).toEqual([allowed, true]);
    }
  });
});

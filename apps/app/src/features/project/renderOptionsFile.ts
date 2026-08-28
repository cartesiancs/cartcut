/**
 * The `renderOptions.json` entry of a `.ngt` project, read and written.
 *
 * A project file is a zip of four JSON entries and this is one of them: the
 * project's own settings, as distinct from its timeline. Pulling the shape out
 * of `functions/project.ts` buys two things.
 *
 * The first is that it can be tested. `project.ts` reaches for
 * `document.querySelector`, `window.electronAPI` and JSZip within a few lines
 * of every branch, so the question "does a frame rate survive a save and a
 * load" had no way to be asked of it. Here it is a round trip between two pure
 * functions.
 *
 * The second is that reading becomes deliberate. The load path used to index
 * straight into the parsed JSON — `options.previewSize.w` — which throws on a
 * truncated file and, for the frame rate, did something worse: it ignored the
 * stored value and substituted a literal 60. Everything a file may be missing
 * is answered here, in one place, from the defaults a fresh project has.
 *
 * **The schema version does not move for a new field.** `project.ts` gates on
 * `schemaVersion !== SCHEMA_VERSION` and *refuses to open* on a mismatch — it
 * is a compatibility check, not a migrator. Adding `fps` as a field that older
 * files simply lack, answered by a default on the way in, is the same
 * convention `@types/timeline.ts` states for element fields: absent means
 * default, and there is no migration pass.
 */

import {
  normalizeExportSettings,
  type ExportSettings,
} from "../export/settings";
import type {
  RenderOptions,
  RenderOptionsInput,
} from "../../states/renderOptionStore";
import { coerceFps } from "../timeline/frames";

/**
 * The entry as it sits on disk.
 *
 * The names are the ones already in the wild — `videoDuration` for what the
 * store calls `duration`, and a `videoDestination`/`previewRatio` pair that
 * nothing reads back — so this is a description of the existing format rather
 * than a redesign of it. Renaming would be a schema change, and a schema change
 * costs every project anyone has already saved.
 */
export type RenderOptionsFile = {
  /** Seconds. */
  videoDuration: number;
  previewRatio: number;
  videoDestination: string;
  backgroundColor: string;
  previewSize: { w: number; h: number };
  /** Whole frames per second. Absent in files written before this existed. */
  fps: number;
  exportSettings: ExportSettings;
};

/** Fields the store does not hold, supplied by the caller at save time. */
export type SaveContext = {
  previewRatio: number;
  videoDestination: string;
};

export function serializeRenderOptions(
  options: RenderOptions,
  context: SaveContext,
): RenderOptionsFile {
  return {
    videoDuration: options.duration,
    previewRatio: context.previewRatio,
    videoDestination: context.videoDestination,
    backgroundColor: options.backgroundColor,
    previewSize: { w: options.previewSize.w, h: options.previewSize.h },
    fps: options.fps,
    exportSettings: options.exportSettings,
  };
}

/** A finite number above zero, or `null` for anything else. */
function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * Read the entry, answering everything it does not say.
 *
 * `defaults` is what a *fresh* project holds — `renderOptionStore`'s initial
 * state — and deliberately not the current one. Falling back to the current
 * store would let a project saved before a field existed inherit whatever the
 * last project happened to set, which is the leak the explicit `exportSettings`
 * pass in the old load path was already guarding against.
 */
export function deserializeRenderOptions(
  raw: unknown,
  defaults: RenderOptions,
): RenderOptionsInput {
  const file: Partial<RenderOptionsFile> =
    raw != null && typeof raw === "object"
      ? (raw as Partial<RenderOptionsFile>)
      : {};

  const size =
    file.previewSize != null && typeof file.previewSize === "object"
      ? file.previewSize
      : undefined;

  return {
    previewSize: {
      w: positive(size?.w) ?? defaults.previewSize.w,
      h: positive(size?.h) ?? defaults.previewSize.h,
    },
    // A file written before frame rates were configurable has no `fps` at all,
    // and that is not an error — it is a 60fps project, which is what every
    // project was. A file with a broken one falls the rest of the way through
    // `coerceFps`.
    fps:
      file.fps == null ? coerceFps(defaults.fps) : coerceFps(file.fps),
    duration: positive(file.videoDuration) ?? defaults.duration,
    backgroundColor:
      typeof file.backgroundColor === "string"
        ? file.backgroundColor
        : defaults.backgroundColor,
    exportSettings: normalizeExportSettings(file.exportSettings),
  };
}

/**
 * The five JSON entries of a `.ngt`, assembled.
 *
 * **The only place a project entry is stringified.** `functions/project.ts`
 * built these inline, interleaved with `document.querySelector`, a toast and a
 * window retitle, so there was no way to ask what a save would write without
 * performing one. Auto Save has to write exactly the same bytes as ⌘S — that
 * is the whole basis of recovering one — so "the same" needs to be a shared
 * function rather than two maintained copies.
 *
 * Pure: no DOM, no IPC, no JSZip. `buildProjectArchive` in `projectArchive.ts`
 * is the half that zips.
 *
 * ## The anchor
 *
 * One parameter decides both `videoDestination` and what
 * `serializeAssetPaths` relativizes against, because they are the same
 * question — *where does this project consider itself to live* — and they must
 * not be allowed to disagree.
 *
 * For ⌘S the anchor is the destination. For an autosave it is the **`.ngt`
 * the autosave stands in for**, not the file being written: anchor an autosave
 * on its own location under `userData/autosave/` and `relativizeInside` emits
 * nothing at all, because no asset is inside that folder, silently discarding
 * the portability half of `assetsFile.ts`. Recovery resolves those same
 * relative paths against the same anchor.
 *
 * The anchor is path arithmetic and never an identity. Recovery reads it to
 * relink and leaves `#projectFile` empty; adopting it as the project's path is
 * what would make the next ⌘S overwrite the user's `.ngt` with a recovered
 * older state.
 */

import type { Timeline } from "../../@types/timeline";
import type { RenderOptions } from "../../states/renderOptionStore";
import { SCHEMA_VERSION, type TimelineTrack } from "../timeline/tracks";
import { serializeAssetPaths } from "./assetsFile";
import { serializeRenderOptions } from "./renderOptionsFile";

/** The five entries of a `.ngt`, as text. `null` for one an archive lacks. */
export type NgtEntries = {
  project: string | null;
  timeline: string | null;
  tracks: string | null;
  renderOptions: string | null;
  assetPaths: string | null;
};

/** Every entry present, which is what a writer produces. */
export type WrittenEntries = { [K in keyof NgtEntries]: string };

export type SerializeProjectInput = {
  elements: Timeline;
  tracks: TimelineTrack[];
  options: RenderOptions;
  /**
   * Where the project considers itself to live. See the header — for ⌘S this
   * is the destination; for an autosave it is the `.ngt` being stood in for.
   */
  anchor: string;
  /**
   * Written into `renderOptions.json` and never read back
   * (`renderOptionsFile.ts` says so). Defaulted rather than required because
   * it comes off a Lit component that an autosave may fire without.
   */
  previewRatio?: number;
};

/** The entry names, in the order they are written. */
export const NGT_ENTRY_NAMES = {
  project: "project.json",
  timeline: "timeline.json",
  tracks: "tracks.json",
  renderOptions: "renderOptions.json",
  assetPaths: "assetPaths.json",
} as const satisfies Record<keyof NgtEntries, string>;

export function serializeProjectEntries(
  input: SerializeProjectInput,
): WrittenEntries {
  const { elements, tracks, options, anchor } = input;

  return {
    // What tells a future version which format this is. A file without it
    // predates tracks, and load refuses on a mismatch rather than migrating —
    // so an added *entry* or field must never move this number.
    project: JSON.stringify({ schemaVersion: SCHEMA_VERSION }),
    timeline: JSON.stringify(elements),
    tracks: JSON.stringify(tracks),
    renderOptions: JSON.stringify(
      serializeRenderOptions(options, {
        previewRatio: input.previewRatio ?? 1,
        videoDestination: anchor,
      }),
    ),
    // Relative paths for whatever sits inside the project's own folder, so the
    // folder can be handed to someone else and still find its media.
    // `timeline.json` keeps its absolute paths either way — they are the
    // fallback for a `.ngt` moved on its own, away from its assets.
    assetPaths: JSON.stringify(
      serializeAssetPaths(elements as Record<string, never>, anchor),
    ),
  };
}

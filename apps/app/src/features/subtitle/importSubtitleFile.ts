/**
 * Reading subtitle files and putting them on the timeline.
 *
 * The one orchestrator behind both entry points: the File menu and a `.srt`
 * dropped on the app. It is the only module here that touches a store.
 *
 * ## The order is the contract
 *
 * 1. **Refuse while the timeline is locked.** A caption session holds the
 *    document and rebuilds it from a baseline on every change, so a caption
 *    placed underneath it would vanish at the session's next frame.
 * 2. **Read and parse everything before placing anything.** A batch that
 *    half-imported and then failed would leave the user to work out which file
 *    got in. `lutImport.ts` states the same rule about installing.
 * 3. **Resolve the clip before planning.** `importCues.ts` explains why a
 *    `sourceKey` naming an element that is gone cannot be detected downstream:
 *    it passes the guard and is silently read as a timeline time.
 * 4. **Mint every id outside the transform.** `applyCaptionCommit` requires it,
 *    because a transform can be run twice and anything minted inside would
 *    differ between the runs.
 * 5. **One `withCheckpoint` for the whole batch.** Several files, dozens of
 *    cues, one press of Cmd+Z. That is the whole reason `createTextElement` was
 *    split out of `addText`.
 *
 * `ensureUndoBaseline` is called deliberately, and `actions.ts#commit` does not
 * call it. Nothing checkpoints on load, so the first edit after opening a
 * project is not undoable (CLAUDE.md lists it as a known rough edge). Importing
 * forty captions is the case where that costs the most, and the baseline costs
 * one entry of a fifty-entry cap.
 */

import { v4 as uuidv4 } from "uuid";
import { renderOptionStore } from "../../states/renderOptionStore";
import { selectionStore } from "../../states/selectionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { ensureUndoBaseline } from "../agent/checkpoint";
import type { CaptionIds } from "../caption/applyCaptions";
import type { CaptionFrame } from "../caption/layout";
import { sourceDisplayName } from "../caption/sources";
import { refusesEdit } from "../editor/timelineLock";
import { isDynamicElement } from "../timeline/geometry";
import type { SubtitleCue, SubtitleFlavour } from "./cues";
import type { SubtitleEncoding } from "./encoding";
import type { SubtitleTimeBase } from "./importChoice";
import { importSubtitles } from "./importCues";
import { readSubtitleFile, subtitleNameFrom } from "./subtitleFile";

export type SubtitleImportOutcome =
  | {
      ok: true;
      placed: number;
      skipped: number;
      files: number;
      flavour: SubtitleFlavour;
      /** Reported, so a garbled result can be explained rather than guessed at. */
      encoding: SubtitleEncoding;
    }
  | { ok: false; message: string };

/** What a file holds, before anything has been decided about placing it. */
export type SubtitleFilePreview = {
  path: string;
  name: string;
  cues: SubtitleCue[];
  skipped: number;
  flavour: SubtitleFlavour;
  encoding: SubtitleEncoding;
};

/**
 * Read every file, or explain why not.
 *
 * Separate from placing so the dialog can show what it is about to import: a
 * cue count is the one fact that tells the user they picked the right file.
 */
export async function readSubtitlePaths(
  paths: readonly string[],
): Promise<
  { ok: true; files: SubtitleFilePreview[] } | { ok: false; message: string }
> {
  if (paths.length === 0) {
    return { ok: false, message: "No subtitle file to read." };
  }

  const files: SubtitleFilePreview[] = [];
  for (const path of paths) {
    const read = await readSubtitleFile(path);
    if (!read.ok) {
      return { ok: false, message: `${subtitleNameFrom(path)}: ${read.message}` };
    }
    files.push({
      path,
      name: subtitleNameFrom(path),
      cues: read.parse.cues,
      skipped: read.parse.skipped,
      flavour: read.parse.flavour,
      encoding: read.encoding,
    });
  }

  if (files.every((file) => file.cues.length === 0)) {
    return {
      ok: false,
      message:
        files.length === 1
          ? `${files[0].name} holds no subtitles.`
          : "Those files hold no subtitles.",
    };
  }

  return { ok: true, files };
}

/**
 * The clip the cues could be timed against, or null.
 *
 * Exactly one selected dynamic clip. Two would leave no way to say which clock
 * the file counts in, and a text clip or a shape has no source window at all.
 */
export function timeBaseClip(): { key: string; name: string } | null {
  const ids = selectionStore.getState().ids;
  if (ids.length !== 1) {
    return null;
  }

  const element = useTimelineStore.getState().getDocument().elements[ids[0]];
  if (element == null || !isDynamicElement(element)) {
    return null;
  }
  return { key: ids[0], name: sourceDisplayName(element.localpath) };
}

/** Place files that `readSubtitlePaths` already read. */
export function placeSubtitleFiles(
  files: readonly SubtitleFilePreview[],
  base: SubtitleTimeBase,
): SubtitleImportOutcome {
  if (refusesEdit()) {
    // `refusesEdit` has already told the user, once per lock.
    return { ok: false, message: "" };
  }

  const store = useTimelineStore.getState();
  // Step 3. A key naming an element that is gone reads as a timeline time
  // downstream with nothing to warn about it, so it is dropped here instead.
  const sourceKey =
    base.kind === "clip" && store.getDocument().elements[base.key] != null
      ? base.key
      : null;

  const cues = files.flatMap((file) => file.cues);
  if (cues.length === 0) {
    return { ok: false, message: "Those files hold no subtitles." };
  }

  // Step 4. Outside the transform, always.
  const ids: CaptionIds[] = cues.map(() => ({
    element: uuidv4(),
    track: uuidv4(),
  }));
  const plan = { cues, frame: frameSize(), sourceKey, ids };

  ensureUndoBaseline();
  // Step 5. One step, however many files and cues.
  store.withCheckpoint((doc) => importSubtitles(doc, plan));

  return {
    ok: true,
    placed: cues.length,
    skipped: files.reduce((total, file) => total + file.skipped, 0),
    files: files.length,
    flavour: files[0].flavour,
    encoding: files.some((file) => file.encoding === "cp949") ? "cp949" : "utf-8",
  };
}

/** Read and place, for a caller with no dialog to show. */
export async function importSubtitlePaths(
  paths: readonly string[],
  base: SubtitleTimeBase,
): Promise<SubtitleImportOutcome> {
  const read = await readSubtitlePaths(paths);
  if (!read.ok) {
    return read;
  }
  return placeSubtitleFiles(read.files, base);
}

function frameSize(): CaptionFrame {
  const size = renderOptionStore.getState().options.previewSize;
  return { w: size.w, h: size.h };
}

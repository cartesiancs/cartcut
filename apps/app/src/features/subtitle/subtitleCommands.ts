/**
 * The two user-facing subtitle commands, with their dialog and their toast.
 *
 * Both entry points land here: the File menu, and a `.srt` dropped on the app.
 * Keeping them in one module is what stops the two from drifting into different
 * behaviour, which is the drift `features/editor/actions.ts` describes about
 * itself.
 *
 * Nothing here decides anything. The clock is `importChoice.ts`, the scope is
 * `exportCues.ts`, the placement is `importCues.ts`; this asks, reports, and
 * stays out of the way.
 *
 * ## What the toasts say, and do not say
 *
 * A count and, when there is one, a fact the user cannot otherwise get: how many
 * cues were unreadable, and which encoding the file turned out to be. The
 * encoding is there because a garbled import is otherwise indistinguishable from
 * a broken importer. Nothing else: a cancelled dialog says nothing at all, which
 * is the rule `lutImport.ts` states about answering null.
 */

import { refusesEdit } from "../editor/timelineLock";
import { exportSubtitles } from "./exportSubtitleFile";
import { askTimeBase } from "./importDialog";
import {
  placeSubtitleFiles,
  readSubtitlePaths,
  timeBaseClip,
} from "./importSubtitleFile";
import { pickSubtitleFiles, subtitleNameFrom } from "./subtitleFile";

function toast(message: string, delay = "3000"): void {
  if (message === "") {
    return;
  }
  const box: any = document.querySelector("toast-box");
  box?.showToast({ message, delay });
}

/** File ▸ Import Subtitles… */
export async function runImportSubtitles(): Promise<void> {
  const paths = await pickSubtitleFiles();
  // Cancelled. Not reported: a toast here tells the user off for changing their
  // mind.
  if (paths.length === 0) {
    return;
  }
  await runImportSubtitlePaths(paths);
}

/** A `.srt` or `.vtt` dropped on the app, or picked from the menu. */
export async function runImportSubtitlePaths(
  paths: readonly string[],
): Promise<void> {
  // **Before the dialog, not after.** `placeSubtitleFiles` refuses too, and has
  // to, since it is the gate any caller goes through. But asking which clock the
  // file counts in and then declining to use the answer is a question posed for
  // nothing. Calling `refusesEdit` twice is safe by design: it announces on the
  // first refusal after each lock and not again.
  if (refusesEdit()) {
    return;
  }

  // Read before asking, so the dialog can show a cue count: it is the one fact
  // that tells the user they picked the file they meant to.
  const read = await readSubtitlePaths(paths);
  if (!read.ok) {
    toast(read.message, "5000");
    return;
  }

  const base = await askTimeBase({
    files: read.files,
    selectedClip: timeBaseClip(),
  });
  if (base == null) {
    return;
  }

  const placed = placeSubtitleFiles(read.files, base);
  if (!placed.ok) {
    // An empty message means `refusesEdit` has already spoken, once per lock.
    toast(placed.message, "5000");
    return;
  }

  toast(importSummary(placed.placed, placed.skipped, placed.encoding));
}

/** File ▸ Export Subtitles… */
export async function runExportSubtitles(): Promise<void> {
  const result = await exportSubtitles();
  if (result.ok) {
    toast(
      `${result.cues} ${plural(result.cues, "subtitle")} written to ${subtitleNameFrom(result.path)}`,
    );
    return;
  }
  if (result.cancelled === true) {
    return;
  }
  toast(result.message, "5000");
}

function importSummary(
  placed: number,
  skipped: number,
  encoding: string,
): string {
  const parts = [`${placed} ${plural(placed, "subtitle")} added`];
  if (skipped > 0) {
    parts.push(`${skipped} skipped`);
  }
  // Named only when it is the unusual one. Saying "UTF-8" on every import would
  // be noise, and saying nothing on a CP949 one leaves a garbled result with no
  // explanation.
  if (encoding === "cp949") {
    parts.push("read as CP949");
  }
  return parts.join(", ");
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

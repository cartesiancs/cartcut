/**
 * Writing the timeline's text clips out as a subtitle file.
 *
 * **The destination is asked for first**, before a single cue is collected.
 * `templateExport.ts` states the reason: building first means throwing the work
 * away when the user cancels. Here the collection is cheap, but the ordering
 * also decides the format, so it has to come first regardless.
 *
 * The format is the extension the user chose in the save dialog. That is why
 * `ipcDialog.saveSubtitles` carries two filters rather than one: picking
 * WebVTT in the dialog is the whole of "export as WebVTT", and a second
 * question about it afterwards would be asking twice.
 */

import { selectionStore } from "../../states/selectionStore";
import { useTimelineStore } from "../../states/timelineStore";
import type { SubtitleFlavour } from "./cues";
import { cuesFromDocument, exportScopeFor } from "./exportCues";
import { serializeSubtitles } from "./serialize";
import {
  flavourForPath,
  pickSubtitleDestination,
  writeSubtitleFile,
} from "./subtitleFile";

export type SubtitleExportOutcome =
  | { ok: true; path: string; cues: number; flavour: SubtitleFlavour }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; message: string };

export type SubtitleExportText =
  | { ok: true; text: string; cues: number; flavour: SubtitleFlavour }
  | { ok: false; message: string };

/**
 * The file's contents, without asking where it goes.
 *
 * Separated from `exportSubtitles` the way `buildTemplateArchive` is separated
 * from `exportTemplate`, and for the same two reasons: something that already
 * knows the destination can skip the dialog, and the assembly becomes reachable
 * from a check that has no dialog to drive. It also decides the refusal, which
 * has to happen **before** the dialog: a save dialog leading to "there was
 * nothing to save" has wasted the user's decision about where to put it.
 */
export function collectSubtitleText(
  flavour: SubtitleFlavour,
): SubtitleExportText {
  const doc = useTimelineStore.getState().getDocument();
  const scope = exportScopeFor(doc, selectionStore.getState().ids);
  const cues = cuesFromDocument(doc, scope);

  if (cues.length === 0) {
    return {
      ok: false,
      message:
        scope.kind === "all"
          ? "This project has no text clips to export."
          : "Nothing selected holds any text.",
    };
  }

  return {
    ok: true,
    text: serializeSubtitles(cues, flavour),
    cues: cues.length,
    flavour,
  };
}

export async function exportSubtitles(): Promise<SubtitleExportOutcome> {
  // Collected against SubRip only to settle whether there is anything to write.
  // The flavour the user picks in the dialog decides the real serialisation, and
  // asking that question first would be asking it about a file that may not
  // exist.
  const ready = collectSubtitleText("srt");
  if (!ready.ok) {
    return { ok: false, message: ready.message };
  }

  const path = await pickSubtitleDestination();
  if (path == null) {
    return { ok: false, cancelled: true };
  }

  const flavour = flavourForPath(path);
  const written = collectSubtitleText(flavour);
  if (!written.ok) {
    return { ok: false, message: written.message };
  }

  const wrote = await writeSubtitleFile(path, written.text);
  if (!wrote.ok) {
    return { ok: false, message: wrote.message };
  }

  return { ok: true, path, cues: written.cues, flavour };
}

/**
 * The `.ngt` zip itself: entries in, bytes out, and back again.
 *
 * The only module that knows a `.ngt` is a zip. `projectEntries.ts` decides
 * *what* the entries say and `projectDocument.ts` reads them back into a
 * document; both are pure, which is what lets them be tested. This is the
 * narrow layer between them and JSZip.
 *
 * Reading is deliberately tolerant: a missing entry comes back `null` rather
 * than throwing, because `readProjectDocument` has an opinion about every
 * absence — an absent `tracks.json` means a project written before tracks
 * existed, and an absent `project.json` means format 1 — and it cannot express
 * that if the read has already thrown.
 */

import JSZip from "jszip";
import {
  NGT_ENTRY_NAMES,
  type NgtEntries,
  type WrittenEntries,
} from "./projectEntries";

/** An extra entry written alongside the five. Auto Save uses it. */
export type ExtraEntries = Record<string, string>;

/**
 * Pull the five entries out of an opened archive.
 *
 * Takes the `JSZip` rather than the bytes so a caller that needs a sixth entry
 * — the autosave's `autosave.json` — reads it from the same `loadAsync`, which
 * is the "one read of the archive, not two" rule the load path already keeps.
 */
export async function readNgtEntries(zip: JSZip): Promise<NgtEntries> {
  const read = async (name: string): Promise<string | null> => {
    const entry = zip.file(name);
    return entry == null ? null : entry.async("string");
  };

  // In parallel: five independent reads of an already-decompressed archive,
  // and nothing about them is ordered.
  const [project, timeline, tracks, renderOptions, assetPaths] =
    await Promise.all([
      read(NGT_ENTRY_NAMES.project),
      read(NGT_ENTRY_NAMES.timeline),
      read(NGT_ENTRY_NAMES.tracks),
      read(NGT_ENTRY_NAMES.renderOptions),
      read(NGT_ENTRY_NAMES.assetPaths),
    ]);

  return { project, timeline, tracks, renderOptions, assetPaths };
}

/** Read one extra entry, or `null`. For `autosave.json`. */
export async function readNgtExtra(
  zip: JSZip,
  name: string,
): Promise<string | null> {
  const entry = zip.file(name);
  return entry == null ? null : entry.async("string");
}

/** Open an archive from whatever `filesystem.readFile` handed back. */
export function openNgt(data: unknown): Promise<JSZip> {
  return JSZip.loadAsync(data as never);
}

function assemble(entries: WrittenEntries, extra: ExtraEntries): JSZip {
  const zip = new JSZip();
  zip.file(NGT_ENTRY_NAMES.project, entries.project);
  zip.file(NGT_ENTRY_NAMES.timeline, entries.timeline);
  zip.file(NGT_ENTRY_NAMES.tracks, entries.tracks);
  zip.file(NGT_ENTRY_NAMES.renderOptions, entries.renderOptions);
  zip.file(NGT_ENTRY_NAMES.assetPaths, entries.assetPaths);
  for (const [name, text] of Object.entries(extra)) {
    zip.file(name, text);
  }
  return zip;
}

/** The archive as a `Blob`, for the save path's base64 hand-off. */
export function buildNgtBlob(
  entries: WrittenEntries,
  extra: ExtraEntries = {},
): Promise<Blob> {
  return assemble(entries, extra).generateAsync({ type: "blob" });
}

/**
 * The archive as bytes, uncompressed.
 *
 * `STORE` rather than the default `DEFLATE`, and only here: an autosave runs
 * every few seconds of editing on the thread that draws the preview, and
 * deflating a `timeline.json` carrying baked animation lanes is the part that
 * would be felt. A recovery file is transient, so the size is not worth the
 * stall. The save path keeps deflating, because it happens once and the file
 * is the user's to keep.
 */
export function buildNgtBytes(
  entries: WrittenEntries,
  extra: ExtraEntries = {},
): Promise<Uint8Array> {
  return assemble(entries, extra).generateAsync({
    type: "uint8array",
    compression: "STORE",
  });
}

/**
 * Writing a SubRip or WebVTT file.
 *
 * Both start with `normalizeCues`, so a file is always sorted and never holds a
 * zero-length cue. That matters more for SubRip than it looks: its cue numbers
 * are sequential, and numbering before sorting would produce a file whose
 * indices and timestamps disagree, which some players read and some refuse.
 *
 * ## WebVTT escapes, SubRip does not
 *
 * This is deliberate, and it is the one asymmetry in the module.
 *
 * WebVTT's cue text is markup: a bare `<` starts a tag, and `&` starts an
 * entity, so both have to be escaped or the file does not say what it means.
 * SubRip has no markup and no entity syntax at all, so escaping there would be
 * a plain regression: a player shows `&amp;` as those five characters, and a
 * user who wrote `Tom & Jerry` gets `Tom &amp; Jerry` burned into their video.
 *
 * `parse.ts` is the other half, and it reads markup per flavour for the same
 * reason. So the round trip is exact through WebVTT for any text at all, and
 * exact through SubRip for any text that is not itself a SubRip formatting tag:
 * `<i>` has one spelling in that format and it means italics. There is nothing
 * to escape it to, so nothing here tries.
 *
 * ## Line endings
 *
 * LF, not CRLF. SubRip is widely described as a CRLF format, and every player,
 * ffmpeg and YouTube accept LF; matching the rest of this codebase is worth more
 * than matching a convention nothing enforces.
 */

import { normalizeCues, type SubtitleCue, type SubtitleFlavour } from "./cues";
import { formatTimecode } from "./timecode";

export function serializeSubtitles(
  cues: readonly SubtitleCue[],
  flavour: SubtitleFlavour,
): string {
  return flavour === "vtt" ? toVtt(cues) : toSrt(cues);
}

export function toSrt(cues: readonly SubtitleCue[]): string {
  return normalizeCues(cues)
    .map(
      (cue, index) =>
        `${index + 1}\n` +
        `${formatTimecode(cue.startMs, "srt")} --> ${formatTimecode(cue.endMs, "srt")}\n` +
        `${cue.text}\n`,
    )
    .join("\n");
}

export function toVtt(cues: readonly SubtitleCue[]): string {
  // The signature stands even with no cues after it. A header-only WebVTT file
  // is valid, and answering with an empty string would write a file no player
  // will open. Callers refuse an empty export before reaching here anyway.
  return (
    "WEBVTT\n\n" +
    normalizeCues(cues)
      .map(
        (cue) =>
          `${formatTimecode(cue.startMs, "vtt")} --> ${formatTimecode(cue.endMs, "vtt")}\n` +
          `${escapeVtt(cue.text)}\n`,
      )
      .join("\n")
  );
}

/**
 * `&` first, or the ampersands this function introduces get escaped again and
 * `<` comes out as `&amp;lt;`.
 */
function escapeVtt(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

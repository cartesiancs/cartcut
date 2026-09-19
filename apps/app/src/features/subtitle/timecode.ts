/**
 * A subtitle timestamp, both directions.
 *
 * The two formats differ in exactly one character: SubRip writes
 * `00:00:01,500` and WebVTT writes `00:00:01.500`. Everything else about the
 * arithmetic is shared, so one pair of functions covers both and the flavour is
 * a parameter rather than a second module.
 *
 * ## Reading is lenient, writing is not
 *
 * Files in the wild are not written by spec-conforming tools. Three shapes turn
 * up constantly and all three are accepted here: a fraction that is not three
 * digits, an omitted hour field (`01:02.500`, which WebVTT actually permits),
 * and a dot where SubRip wants a comma. The fraction is the one that bites: a
 * parser reading `,05` as 5 milliseconds instead of 50 is wrong by a factor of
 * ten and looks completely plausible in a diff, which is why the suite requires
 * `,5`, `,50` and `,500` to disagree.
 *
 * Writing emits exactly one shape per flavour. In particular **WebVTT keeps its
 * hour field** even though dropping it is legal: two output forms would double
 * the round-trip table and buy nothing, since every reader accepts the long one.
 */

import type { SubtitleFlavour } from "./cues";

/**
 * Anchored on purpose. An unanchored match would read the `00:00:01,000` out of
 * `align:start 00:00:01,000` and call a cue setting a timestamp.
 *
 * The hour group is `\d+` rather than `\d{2}` so a file past 99 hours reads
 * back, and the minute and second groups accept one digit because hand-edited
 * files routinely carry `0:01:02,000`.
 */
const TIMECODE = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d+))?$/;

/** Milliseconds, or null when this is not a timestamp at all. */
export function parseTimecode(raw: string): number | null {
  const match = TIMECODE.exec(raw.trim());
  if (match == null) {
    return null;
  }

  const [, hours, minutes, seconds, fraction] = match;

  return (
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1000 +
    millisecondsOf(fraction)
  );
}

/** How a timestamp reads in a file of this flavour. */
export function formatTimecode(ms: number, flavour: SubtitleFlavour): string {
  // Clamped rather than refused: a negative time cannot be written, and
  // throwing here would fail an export over one bad cue out of four hundred.
  const total = Math.max(0, Math.round(ms));
  const separator = flavour === "srt" ? "," : ".";

  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor(total / 60_000) % 60;
  const seconds = Math.floor(total / 1000) % 60;

  // `pad` widens rather than truncates, so a 100-hour timeline writes `100:…`
  // instead of wrapping to `00:…`.
  return (
    `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}` +
    `${separator}${pad(total % 1000, 3)}`
  );
}

/**
 * A fraction-of-a-second digit string as milliseconds.
 *
 * Right-padded to three digits, then truncated to three: `5` is five hundred
 * milliseconds and `5000` is five hundred too. Reading the digits as an integer
 * instead would make `05` five milliseconds, which is the defect named in the
 * header.
 */
function millisecondsOf(fraction: string | undefined): number {
  if (fraction == null || fraction.length === 0) {
    return 0;
  }
  return Number(fraction.padEnd(3, "0").slice(0, 3));
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

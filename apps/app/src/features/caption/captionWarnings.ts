/**
 * What the caption session has to tell the user about its cuts, as toasts.
 *
 * These used to fire once, at `start`, because that was when the silences were
 * cut. A session starts with nothing cut now (`silenceButton.ts#
 * SILENCE_CUT_ON_START`), so at `start` two of the three could never fire and
 * the third said "not cut" about a clip nobody had asked to cut. They are
 * judged on every change instead and each is shown the first time it is true,
 * which is the moment the silence button (or a struck-out line) first makes a
 * cut that needs explaining.
 *
 * A warning's `key` carries its count, so the caller can show each one once:
 * switching the gaps off and on again lands on the same key and stays quiet,
 * while a cut that strands one more clip is a new key and is said.
 */

export type CaptionWarningInput = {
  /** How many clips the session holds. Only for the wording. */
  clipCount: number;
  /** Whether the panel is asking for any cut at all. */
  cutting: boolean;
  /** `CaptionSession#coveredClips`. */
  covered: number;
  /** `CaptionSession#refusedClips`. */
  refused: number;
  /** `CaptionSession#strandedClips`. */
  stranded: number;
};

export type CaptionWarning = { key: string; message: string };

export function captionWarnings(input: CaptionWarningInput): CaptionWarning[] {
  const out: CaptionWarning[] = [];

  if (input.covered > 0) {
    out.push({
      key: `covered:${input.covered}`,
      message:
        input.covered === 1 && input.clipCount === 1
          ? "Those cuts cover the whole clip, so it was not cut. The captions are placed."
          : `The cuts cover ${input.covered} whole clip(s), so those were not cut. Their captions are placed.`,
    });
  }

  // Refused at `start`, but only worth saying once something is to be cut:
  // before that, "not cut" describes what the user asked for.
  if (input.cutting && input.refused > 0) {
    out.push({
      key: `refused:${input.refused}`,
      message: `${input.refused} clip(s) overlap another chosen clip or sit on no video or audio track, so they are not cut. Their captions are placed.`,
    });
  }

  // The ripple is lane-local, so anything on another row keeps its old timing
  // and drifts out of sync with the speech. Said plainly rather than
  // discovered at playback.
  if (input.stranded > 0) {
    out.push({
      key: `stranded:${input.stranded}`,
      message: `${input.stranded} clip(s) on other tracks overlap the cuts and were not moved, so they may now be out of sync.`,
    });
  }

  return out;
}

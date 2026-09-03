/**
 * Lining the microphone up with the picture.
 *
 * Four capture sources start at four slightly different moments. `getUserMedia`
 * for a camera negotiates with the OS and can take half a second; a desktop
 * capture usually starts sooner; an `AudioWorklet` starts almost immediately but
 * only after its module has been fetched and compiled. Nothing coordinates
 * them, so "press record" is four different instants and a naive mux drifts lip
 * sync by however far apart they were.
 *
 * The fix is boring and exact: each producer records `performance.now()` when
 * its *first* real datum arrives, and everything is expressed relative to the
 * picture. Same renderer, same clock, so the numbers are comparable — which is
 * the reason capture lives in one window rather than spread across two.
 *
 * Audio is corrected rather than video because audio is the cheap one to
 * correct: prepending silence to PCM is memcpy, while shifting a video track
 * means either re-timestamping every frame or asking the muxer for an edit list
 * that half the decoders in the world ignore.
 *
 * Pure arithmetic. No clock is read in here — the callers pass their readings
 * in, which is what makes it testable at all.
 */

/**
 * Largest correction that is believed.
 *
 * Beyond five seconds the two readings are not "slightly apart", they are
 * evidence that something never started. Padding five seconds of silence onto a
 * recording would hide that; refusing to and saying so does not.
 */
export const MAX_ALIGN_MS = 5_000;

export type AlignPlan = {
  /** Silence to prepend, in whole audio frames (samples per channel). */
  padFrames: number;
  /** Audio frames to drop from the front. */
  trimFrames: number;
  /** The uncorrected offset, kept for logging and for the tests. */
  offsetMs: number;
  /**
   * The offset was past `MAX_ALIGN_MS` and was ignored.
   *
   * Not an error: a recording that is out of sync is still a recording, and the
   * caller decides whether to warn. But nothing silently pads a wild figure.
   */
  clamped: boolean;
};

/**
 * How to correct the microphone so it lines up with the first video frame.
 *
 * A positive offset means audio started *after* the picture, so the front of
 * the audio needs silence. A negative one means it started first, so the front
 * is trimmed. Exactly one of `padFrames` and `trimFrames` is ever non-zero.
 */
export function alignAudioToVideo(
  videoT0Ms: number,
  audioT0Ms: number,
  sampleRate: number,
): AlignPlan {
  const rate =
    Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48_000;

  if (!Number.isFinite(videoT0Ms) || !Number.isFinite(audioT0Ms)) {
    return { padFrames: 0, trimFrames: 0, offsetMs: 0, clamped: false };
  }

  const offsetMs = audioT0Ms - videoT0Ms;

  if (Math.abs(offsetMs) > MAX_ALIGN_MS) {
    return { padFrames: 0, trimFrames: 0, offsetMs, clamped: true };
  }

  const frames = Math.round((Math.abs(offsetMs) / 1000) * rate);

  return offsetMs >= 0
    ? { padFrames: frames, trimFrames: 0, offsetMs, clamped: false }
    : { padFrames: 0, trimFrames: frames, offsetMs, clamped: false };
}

/**
 * Every source's start, expressed against the earliest of them.
 *
 * Used by the composite pass, where the camera's first frame is usually later
 * than the screen's: the bubble must not be drawn before there is a bubble, and
 * drawing the camera's first frame from time zero would freeze a still of an
 * unlit sensor over the opening seconds.
 *
 * Unreadable entries are dropped rather than defaulted to zero — a source that
 * never started has no offset, and calling it "simultaneous" would place its
 * first frame at the top of the recording.
 */
export function relativeOffsets(
  starts: Readonly<Record<string, number>>,
): Record<string, number> {
  const usable = Object.entries(starts).filter(([, value]) =>
    Number.isFinite(value),
  );

  if (usable.length === 0) {
    return {};
  }

  const earliest = Math.min(...usable.map(([, value]) => value));

  return Object.fromEntries(
    usable.map(([key, value]) => [key, value - earliest]),
  );
}

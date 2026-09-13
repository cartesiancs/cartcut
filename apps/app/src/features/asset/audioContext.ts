/**
 * The one `AudioContext`, and the gesture that starts it.
 *
 * There are two things in the renderer that need WebAudio and they want it for
 * opposite reasons: `timeline/strip/audioPeaks.ts` decodes files to draw
 * waveforms, and `audioGraph.ts` routes playback so a clip can be boosted past
 * unity. Neither needs its own context, and an `AudioContext` is a limited
 * per-document resource that Chromium will eventually refuse to hand out.
 * `audioPeaks.ts` already said so in the comment on its shared provider; this
 * module is that sentence made structural.
 *
 * Deliberately never closed, for the same reason the peak cache is never
 * disposed: it outlives every component that reads it, and one closed by the
 * last component to unmount is one that cannot be reopened.
 *
 * DOM-dependent by definition, so nothing under `features/timeline/` may import
 * it. The playback side reaches it through the `GainSink` port instead.
 */

let shared: AudioContext | null = null;
/** Set once construction has failed, so the failure costs one attempt. */
let unavailable = false;

/**
 * The shared context, or `null` where there is none to be had.
 *
 * `null` covers a test environment with no `window`, a browser that has neither
 * constructor, and a document that has run out of contexts. Every caller has to
 * survive it: the waveform draws nothing and the level plays at unity, which
 * are both a great deal better than throwing out of a draw loop.
 */
export function sharedAudioContext(): AudioContext | null {
  if (shared != null || unavailable) {
    return shared;
  }
  const Ctor =
    typeof window === "undefined"
      ? undefined
      : ((window as any).AudioContext ?? (window as any).webkitAudioContext);
  if (Ctor == null) {
    unavailable = true;
    return null;
  }
  try {
    shared = new Ctor();
  } catch {
    unavailable = true;
  }
  return shared;
}

/**
 * Nudge the context into `running`, if there is one.
 *
 * A context constructed without a user gesture starts suspended, and a
 * suspended context passes no sound at all. That is survivable for decoding,
 * which does not need the clock, and fatal for playback: a handle routed
 * through a suspended graph is silent rather than quiet.
 *
 * So this is called from the play command, where a click has just happened.
 * `record/audioRecord.ts` makes the same call for the same reason, and its
 * note applies here too: resuming an already-running context costs nothing, so
 * there is no need to check first.
 */
export function resumeAudioContext(): void {
  void sharedAudioContext()
    ?.resume()
    .catch(() => {});
}

import type { GainSink } from "../timeline/playback";

/**
 * The preview's gain sink with the output muted, or the sink itself.
 *
 * A master fader at zero rather than `handle.muted`, because `muted` is already
 * taken: `playback.ts#intentFor` writes it on every repaint to say whether a
 * clip is in its window, so a second writer would be overwritten one frame
 * later. The sink is the one place every level passes through, and the level
 * written there is not the one the user chose (that stays in the document), so
 * unmuting is the next repaint writing the document's level back.
 *
 * Zero goes through the wrapped sink, not straight to `handle.volume`: a clip
 * boosted past unity carries its level on a `GainNode` with `volume` held at 1
 * (`asset/audioGraph.ts`), and only the sink knows which handles those are.
 *
 * Unmuted answers the sink by identity, so the common case costs nothing.
 */
export function mutedSink(sink: GainSink, muted: boolean): GainSink {
  if (!muted) {
    return sink;
  }
  return (handle) => sink(handle, 0);
}

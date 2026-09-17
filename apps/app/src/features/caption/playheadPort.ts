/**
 * The panel's view of the playhead.
 *
 * The auto-caption panel used to play its own copy of the source file, on its
 * own clock, behind its own canvas. It does not any more: the edit is on the
 * real timeline from the moment the transcript lands, so the app's own preview
 * is the preview and the app's own playhead is the clock.
 *
 * The panel cannot reach the store to read it. `apps/automatic-caption/`
 * resolves its packages from its own `node_modules`, so importing zustand there
 * would mean a second copy of it in the bundle. `Control` already passes
 * `previewSize` and `backgroundColor` down for that reason, and this is the
 * same arrangement for a value that changes sixty times a second.
 *
 * ## It is in source seconds, both ways
 *
 * Which hides two conversions the panel has no business knowing about: the
 * clip's own trim and speed, and then the cuts the session has applied. The
 * panel counts in source seconds because that is what a transcript timestamps
 * and what `lines.ts` compares against, and it should go on counting in
 * exactly one unit.
 *
 * Every answer names its clip, because a session can hold several and each
 * counts in its own file's seconds. The playhead can be over none of them (the
 * gap between two clips) or over two at once (two chosen clips on two tracks),
 * so the answer is a list.
 *
 * ## `subscribe` rather than a property
 *
 * A `@property` on `<automatic-caption>` written at playback rate would make
 * `Control` re-render at playback rate, and `Control` is the component that
 * holds the whole preview column. Handing over a stable object instead keeps
 * the frequency inside the panel, where `ChromeGate` already exists to drop it
 * by two orders of magnitude before anything re-renders.
 */

/** A moment of one chosen clip's file. */
export type CaptionSourcePosition = { key: string; seconds: number };

export type CaptionPlayheadPort = {
  /** Fires on every playhead change. Returns the unsubscribe. */
  subscribe(onChange: () => void): () => void;
  /** Every chosen clip the playhead is over, in the chosen order. */
  sourcePositions(): CaptionSourcePosition[];
  /** Put the playhead at a moment of one clip's file. */
  seekToSource(key: string, seconds: number): void;
};

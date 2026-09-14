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
 * ## `subscribe` rather than a property
 *
 * A `@property` on `<automatic-caption>` written at playback rate would make
 * `Control` re-render at playback rate, and `Control` is the component that
 * holds the whole preview column. Handing over a stable object instead keeps
 * the frequency inside the panel, where `ChromeGate` already exists to drop it
 * by two orders of magnitude before anything re-renders.
 */

export type CaptionPlayheadPort = {
  /** Fires on every playhead change. Returns the unsubscribe. */
  subscribe(onChange: () => void): () => void;
  /** Where the playhead is, in source-file seconds. */
  sourceSeconds(): number;
  /** Put the playhead at a moment of the source file. */
  seekToSource(seconds: number): void;
};

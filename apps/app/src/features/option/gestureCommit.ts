/**
 * One undo step per gesture, not per event.
 *
 * `number-input` dispatches `onChange` on every mousemove of a scrub, so a
 * single drag across a spinner emits hundreds of them. Committing each one
 * would push hundreds of entries and evict the whole 50-deep undo stack — the
 * user drags the opacity field once and loses every edit they made before it.
 *
 * So the gesture previews through `previewDocument`, which records nothing, and
 * commits once when it settles: on the next `mouseup`, or after a short idle
 * for input that arrives from the keyboard rather than a drag.
 *
 * This is the same shape the timeline canvas already uses for clip drags —
 * recompute from the document as it was when the gesture began, write to the
 * store exactly once — just triggered by a different kind of event.
 */

import { useTimelineStore } from "../../states/timelineStore";
import type { TimelineDocument } from "../timeline/tracks";

/** How long a gesture may pause before it counts as finished. */
export const GESTURE_IDLE_MS = 350;

export type GestureCommitOptions = {
  /**
   * How long a pause ends the gesture, or `null` for "only a mouseup does".
   *
   * The idle timer is there for a value typed into a spinner, which never
   * produces a mouseup. A canvas drag always does — and pausing mid-drag to aim
   * is normal, so the timer would cut one resize into two undo entries the
   * moment the user stopped to think.
   */
  idleMs?: number | null;
};

export class GestureCommit {
  /** The document as it stood when the gesture opened, for `cancel`. */
  private base: TimelineDocument | null = null;
  private active = false;
  /** Whether any step actually changed the document. */
  private changed = false;
  private timer = 0;
  private readonly idleMs: number | null;
  private readonly flushBound = () => this.flush();

  constructor(options: GestureCommitOptions = {}) {
    this.idleMs = options.idleMs === undefined ? GESTURE_IDLE_MS : options.idleMs;
  }

  /**
   * Fold one more change into the current gesture.
   *
   * `fn` is applied to the document as it stands *now*, not to a snapshot taken
   * when the gesture opened. These are absolute setters — "opacity is 40",
   * "there is a keyframe at 500ms worth 40" — so re-applying is idempotent and
   * the scrub still collapses to one keyframe rather than a hundred. Working
   * from the live document is what keeps an edit that lands mid-gesture (an
   * async asset finishing, a clip drag committing) from being erased.
   */
  apply(fn: (doc: TimelineDocument) => TimelineDocument): void {
    const store = useTimelineStore.getState();

    if (!this.active) {
      this.active = true;
      this.changed = false;
      this.base = store.getDocument();
      // A scrub ends with a mouseup wherever the pointer happens to be.
      //
      // Registered here, on the first change, and therefore *after* the one
      // `scrubSession` registered when the button went down — window listeners
      // run in registration order, so on release the drag ends first and this
      // flush lands second. That ordering is what lets `<number-input>` hold
      // its value against the store for the length of the gesture and still be
      // resynced by the checkpoint's own notification. Moving either
      // registration breaks it silently.
      window.addEventListener("mouseup", this.flushBound, { once: true });
    }

    const before = store.getDocument();
    const next = fn(before);
    // The pure ops return their input by identity when they decline.
    if (next !== before) {
      this.changed = true;
    }
    store.previewDocument(next);

    window.clearTimeout(this.timer);
    if (this.idleMs != null) {
      this.timer = window.setTimeout(this.flushBound, this.idleMs);
    }
  }

  /** End the gesture, recording a single undo step if anything changed. */
  flush(): void {
    window.clearTimeout(this.timer);
    this.timer = 0;
    window.removeEventListener("mouseup", this.flushBound);

    const changed = this.changed;
    this.active = false;
    this.changed = false;
    this.base = null;

    if (!changed) {
      return;
    }

    // Commit exactly what is on screen. No rewind: the previews recorded no
    // history, so the entry already on the stack *is* the pre-gesture state,
    // and rewinding would only throw away anything else that landed meanwhile.
    const shown = useTimelineStore.getState().getDocument();
    useTimelineStore.getState().withCheckpoint(() => shown);
  }

  /** Drop a gesture in progress, restoring what was there before it. */
  cancel(): void {
    window.clearTimeout(this.timer);
    this.timer = 0;
    window.removeEventListener("mouseup", this.flushBound);
    if (this.base != null) {
      useTimelineStore.getState().previewDocument(this.base);
    }
    this.base = null;
    this.active = false;
    this.changed = false;
  }
}

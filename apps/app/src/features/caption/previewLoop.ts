/**
 * The auto-caption preview's two animation-frame handles, and its re-render gate.
 *
 * Small, and extracted for one reason: **there are two handles, they are
 * cancelled in different combinations by four different methods, and none of it
 * was reachable from a test.** The panel's own playback methods are straight
 * lines of three calls each and stay where they are — a mock-based test over
 * them would assert "pause was called" because the code calls pause, and pass
 * after any refactor that kept calling pause. The handles are the part with
 * actual invariants, and the part where a leak is silent.
 *
 * `window.requestAnimationFrame` is reached only through `FrameScheduler`, so
 * this runs under `environment: "node"` against a fake — the narrowing
 * `ui/transientModal.ts` does to `bootstrap.Modal`, for the same reason.
 *
 * ## Two handles, not one
 *
 * - the **loop**, re-armed every frame while playing;
 * - the **paint**, a single coalesced repaint for an edit made while paused.
 *
 * They are deliberately independent, and the consequences are pinned in the
 * suite rather than tidied: `start()` cancels a pending loop but *not* a pending
 * paint, and the loop calls its step directly rather than through
 * `schedulePaint`. So "at most one repaint in flight" is **not** an invariant of
 * this class, and a test asserting it would be asserting something the panel has
 * never done.
 */

import { playheadLabel } from "../media/playback";
import { activeAt, type CaptionLine } from "./lines";

/** The part of `window` the loop needs. */
export type FrameScheduler = {
  request(callback: () => void): number;
  cancel(id: number): void;
};

/** `window`, as a scheduler. */
export function windowScheduler(): FrameScheduler {
  return {
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (id) => window.cancelAnimationFrame(id),
  };
}

export class PreviewLoop {
  /** Set by `stop`, read only when deciding whether to re-arm. */
  private done = true;
  private loopId: number | null = null;
  private paintId: number | null = null;
  private step: (() => void) | null = null;

  constructor(private readonly scheduler: FrameScheduler) {}

  /** Whether a frame is armed. For assertions. */
  get isRunning(): boolean {
    return this.loopId !== null;
  }

  /** Whether a coalesced repaint is armed. For assertions. */
  get hasPendingPaint(): boolean {
    return this.paintId !== null;
  }

  /**
   * Run `step` every frame until stopped.
   *
   * Cancels a frame already armed first, so double-clicking Play cannot leave
   * two loops running — which would composite the frame twice and advance
   * nothing, on the thread doing the compositing.
   *
   * It does **not** cancel a pending paint. A repaint coalesced while paused
   * therefore still fires, alongside the loop's first frame.
   */
  start(step: () => void): void {
    this.done = false;
    if (this.loopId !== null) {
      this.scheduler.cancel(this.loopId);
    }
    this.step = step;
    this.loopId = this.scheduler.request(() => this.tick());
  }

  /** Cancel both handles and clear them. */
  stop(): void {
    this.done = true;
    if (this.loopId !== null) {
      this.scheduler.cancel(this.loopId);
      this.loopId = null;
    }
    if (this.paintId !== null) {
      this.scheduler.cancel(this.paintId);
      this.paintId = null;
    }
  }

  /**
   * Repaint once, on the next frame.
   *
   * Coalescing is the whole point: an edit that dirties the picture several times
   * in one turn — a keystroke that both changes the text and moves the caret —
   * costs one composite. A second call while one is armed is ignored rather than
   * queued.
   *
   * Deliberately **not** gated on `stop()` having been called. The panel calls
   * `stop()` and then `schedulePaint()` in that order to draw one last frame
   * after pausing, so a guard here would blank the preview on every pause.
   */
  schedulePaint(paint: () => void): void {
    if (this.paintId !== null) {
      return;
    }
    this.paintId = this.scheduler.request(() => {
      this.paintId = null;
      paint();
    });
  }

  private tick(): void {
    this.step?.();
    // Re-armed *after* the step, so a `stop()` from inside it wins. The id of
    // the frame currently running is left in place until then, which is what
    // makes that `stop()` cancel an already-fired id — harmless, and the reason
    // `done` rather than the id decides whether to continue.
    if (!this.done) {
      this.loopId = this.scheduler.request(() => this.tick());
    }
  }
}

/**
 * What the caption list and the playhead readout are showing, as one string.
 *
 * The 60Hz loop used to call `requestUpdate()` every frame, rebuilding a
 * `TemplateResult` for every word of the whole transcript sixty times a second,
 * on the thread compositing the frame. Nothing in the template moves that fast:
 * only which word is highlighted, and a readout rounded to whole seconds.
 */
export function chromeKey(lines: CaptionLine[], timeSec: number): string {
  const { lineIndex, wordIndex } = activeAt(lines, timeSec);
  return `${lineIndex ?? -1}:${wordIndex ?? -1}`;
}

/**
 * Remembers what the template last showed, so an unchanged frame costs nothing.
 *
 * The label is gated on the **string the template actually renders**, not on a
 * rounded second. `formatPlayhead` floors, so gating on `Math.round` would hold
 * the re-render back across the very boundary where the readout changes and
 * leave it a second stale.
 */
export class ChromeGate {
  private shownActive = "";
  private shownLabel = "";

  /**
   * Whether anything the template shows has changed — and records it if so.
   *
   * Both strings start empty, which is not a state either argument can take
   * (`chromeKey` always has a colon in it), so the first call always answers
   * true.
   */
  changed(active: string, label: string): boolean {
    if (active === this.shownActive && label === this.shownLabel) {
      return false;
    }
    this.shownActive = active;
    this.shownLabel = label;
    return true;
  }
}

/** The gate's two inputs for one moment. */
export function chromeStateOf(
  lines: CaptionLine[],
  timeSec: number,
  durationSec: number,
): { active: string; label: string } {
  return {
    active: chromeKey(lines, timeSec),
    label: playheadLabel(timeSec, durationSec),
  };
}

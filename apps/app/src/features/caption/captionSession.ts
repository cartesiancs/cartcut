/**
 * The caption session: the state machine that owns the timeline while the
 * auto-caption panel is open.
 *
 * It starts the moment a transcript lands, not when Apply is pressed. From then
 * until the user applies or closes the window, the document in the store is a
 * projection of a held `baseline` and whatever the panel currently says. The
 * user watches it, plays it and scrubs it; they do not own it, which is what
 * the lock is for.
 *
 * Everything it touches arrives as a port, the arrangement `autosaveSession.ts`
 * and `transcribeSession.ts` both take and for the same reason: the orderings
 * here are the part that can be wrong, and none of them is reachable from a
 * test if the store is imported directly.
 *
 * ## Nothing it does is an undo step until Apply
 *
 * Every intermediate write goes through `preview`, which is
 * `timelineStore#previewDocument`: no normalisation, no history. One baseline
 * entry is recorded at the start through `ensureBaseline`, and one entry at the
 * end through `commitShown`. So Cmd+Z after Apply goes back to exactly the
 * project as it was before the panel touched it, in one press, however many
 * captions and cuts that covers.
 *
 * `commitShown` commits **what is on screen** rather than recomputing. That is
 * `GestureCommit.flush`'s rule, and the reason is the same: a second
 * computation is a second chance to disagree with the picture the user just
 * approved.
 *
 * ## Closing discards, and that is the only other way out
 *
 * `removeRanges` has no inverse. Nothing anywhere can put cut footage back
 * except a document that still has it, so the baseline is held by reference for
 * the life of the session and `cancel` writes it straight back.
 *
 * ## Every exit unlocks
 *
 * `apply` and `cancel` both end in `finish`, which is the only thing that calls
 * `unlock`. A lock outliving its session leaves the editor inert with no
 * visible cause and nothing offering to release it, so the pairing is worth
 * being structural rather than remembered.
 */

import type { TimelineElement } from "../../@types/timeline";
import type { TimeRange } from "../timeline/clipOps";
import { isDynamicElement, sourceTimeAt } from "../timeline/geometry";
import { shiftPoint, unshiftPoint } from "../timeline/rippleMap";
import type { TimelineDocument } from "../timeline/tracks";
import {
  advanceProjection,
  buildCaptionPlan,
  mintSessionIds,
  revealSteps,
  startProjection,
  type CaptionPlan,
  type CaptionSessionIds,
  type ProjectionState,
  type RevealStep,
} from "./captionProjection";
import { revealDone, stepsDueAt } from "./captionReveal";
import { EMPTY_CUT_PLAN, planCuts, type CutPlan } from "./cuts";
import type { CaptionFrame, CaptionPlacement } from "./layout";
import type { CaptionLine } from "./lines";
import type { FrameScheduler } from "./previewLoop";
import { captionToTimeline } from "./timing";

/** The store, narrowed to the four things a session does to it. */
export type CaptionDocumentPort = {
  read(): TimelineDocument;
  /** Show a document without normalising it or recording an undo step. */
  preview(doc: TimelineDocument): void;
  /** Record one undo step holding exactly what `preview` last showed. */
  commitShown(): void;
  /** Leave a history entry for the state before the session, if there is none. */
  ensureBaseline(): void;
};

export type CaptionLockPort = { lock(): void; unlock(): void };

export type CaptionSessionPorts = {
  document: CaptionDocumentPort;
  lock: CaptionLockPort;
  scheduler: FrameScheduler;
  now: () => number;
  mintId: () => string;
  /**
   * Put a time on the project's frame grid.
   *
   * A port because the grid lives in `renderOptionStore` and this module must
   * not read a store, the same rule `planCuts` keeps about the parameter it
   * takes. It matters that it is the *same* grid the mouse is held to, or a
   * cut edge lands between two frames where nothing renders.
   */
  snap: (ms: number) => number;
  /** Told when the session moves between its phases. For the panel's screen. */
  onPhase?: (phase: CaptionSessionPhase) => void;
};

/** What the panel hands over once it has words and silences. */
export type CaptionSessionStart = {
  lines: CaptionLine[];
  /** The transcribed clip, read **before** anything cuts it. */
  sourceKey: string | null;
  source: TimelineElement | undefined;
  frame: CaptionFrame;
  placement: CaptionPlacement;
  /**
   * What to cut, in **source** milliseconds.
   *
   * Source rather than timeline, and unplanned rather than planned, because the
   * two things that feed it are both authored against the file: the silences
   * the sweep found, and the span of every line the user has struck out. The
   * session plans them, which is also what keeps "resolve the clip before
   * cutting it" true past the first change: the baseline clip is held here, and
   * `doc.elements[sourceKey]` is a *piece* of it by then, or gone.
   */
  sourceRanges: TimeRange[];
};

/** What the panel hands over on every later change. */
export type CaptionSessionUpdate = {
  lines: CaptionLine[];
  placement: CaptionPlacement;
  /** Source ms, rebuilt by the panel from its lines and its toggle. */
  sourceRanges: TimeRange[];
};

export type CaptionSessionPhase = "idle" | "revealing" | "live";

export class CaptionSession {
  private phase: CaptionSessionPhase = "idle";
  private baseline: TimelineDocument | null = null;
  private sourceKey: string | null = null;
  private source: TimelineElement | undefined;
  private frame: CaptionFrame = { w: 1920, h: 1080 };
  private cutPlan: CutPlan = EMPTY_CUT_PLAN;
  private lines: CaptionLine[] = [];
  private placement: CaptionPlacement = "lowerThird";
  private ids: CaptionSessionIds | null = null;
  private plan: CaptionPlan | null = null;
  private steps: RevealStep[] = [];
  private projection: ProjectionState | null = null;
  private revealStartedAt = 0;
  private frameHandle: number | null = null;
  private rebuildPending = false;

  constructor(private readonly ports: CaptionSessionPorts) {}

  get isLive(): boolean {
    return this.phase !== "idle";
  }

  get currentPhase(): CaptionSessionPhase {
    return this.phase;
  }

  /** The cuts as they will be made: timeline ms, snapped, merged, descending. */
  get cuts(): TimeRange[] {
    return this.cutPlan.cuts;
  }

  /**
   * Whether the ranges asked for would leave no footage at all.
   *
   * The cuts are dropped when they would, and the captions placed anyway. That
   * half is recoverable by hand; an emptied track is not, and it would take
   * every caption's anchor with it.
   */
  get coversWholeClip(): boolean {
    return this.cutPlan.coversWholeClip;
  }

  /**
   * Begin.
   *
   * The baseline is read from the store **after** `ensureBaseline`, so the
   * entry that lands in history and the document held here are the same state.
   * Reading first would be the same thing today and would stop being so the
   * moment `ensureBaseline` ever normalised anything.
   */
  start(input: CaptionSessionStart): void {
    if (this.phase !== "idle") {
      this.cancel();
    }

    this.ports.document.ensureBaseline();
    this.baseline = this.ports.document.read();
    this.sourceKey = input.sourceKey;
    this.source = input.source;
    this.frame = input.frame;
    this.lines = input.lines;
    this.placement = input.placement;
    this.ids = null;
    this.replan(input.sourceRanges);

    this.ports.lock.lock();
    this.setPhase("revealing");
    this.rebuildPlan();

    this.projection = startProjection(this.baseline);
    this.revealStartedAt = this.ports.now();
    this.tick();
  }

  /**
   * A text edit, a split, a merge, a strike-out, a placement change, a toggle.
   *
   * One entry point for all of them, because they are all the same thing: the
   * panel says what it now wants and the projection is rebuilt from the
   * baseline. The silence toggle is not a special case and has no undo of its
   * own; switching it off simply means the panel sends fewer ranges.
   */
  update(input: CaptionSessionUpdate): void {
    if (this.phase === "idle") {
      return;
    }
    this.lines = input.lines;
    this.placement = input.placement;
    this.replan(input.sourceRanges);
    this.requestRebuild();
  }

  /**
   * Confirm.
   *
   * The reveal is run to its end first. Applying halfway would commit a
   * document missing the captions that had not landed yet, which is not a state
   * the user chose or could have seen coming.
   */
  apply(): void {
    if (this.phase === "idle") {
      return;
    }
    this.settleNow();
    this.ports.document.commitShown();
    this.finish();
  }

  /** Give the project back exactly as it was. */
  cancel(): void {
    if (this.phase === "idle") {
      return;
    }
    const baseline = this.baseline;
    this.finish();
    if (baseline != null) {
      this.ports.document.preview(baseline);
    }
  }

  /**
   * Where a moment of the source file sits on the timeline now.
   *
   * What the panel's word chips seek to. Two conversions, in this order: the
   * clip's own trim and speed, then the cuts. Doing them the other way round
   * would ripple a time that is not on the timeline yet.
   */
  timelineMsOf(sourceMs: number): number {
    const onOriginal = captionToTimeline(
      { startTime: sourceMs, duration: 1 },
      this.source,
    ).startTime;
    return shiftPoint(onOriginal, this.plan?.cuts ?? []);
  }

  /**
   * The inverse, for the highlight.
   *
   * Answers in **seconds**, because that is what `lines.ts` counts in and what
   * `activeAt` compares against. The panel asks this once per playhead change,
   * filtered by `ChromeGate`.
   */
  sourceSecondsOf(timelineMs: number): number {
    const onOriginal = unshiftPoint(timelineMs, this.plan?.cuts ?? []);
    const source = this.source;
    if (source == null || !isDynamicElement(source)) {
      return onOriginal / 1000;
    }
    return sourceTimeAt(source, onOriginal) / 1000;
  }

  // --------------------------------------------------------------- internals

  /**
   * Turn the panel's source ranges into the cuts that will be made.
   *
   * Against the clip as the session first saw it, never as it stands: by the
   * second change the original id names a piece of the clip or nothing at all,
   * and `planCuts` would answer `EMPTY_CUT_PLAN` or clamp to the wrong window.
   */
  private replan(sourceRanges: TimeRange[]): void {
    const plan = planCuts(sourceRanges, this.source, this.ports.snap);
    this.cutPlan = plan.coversWholeClip
      ? { ...plan, cuts: [] }
      : plan;
  }

  private rebuildPlan(): void {
    this.ids = mintSessionIds(
      this.ids,
      this.lines,
      this.cutPlan.cuts.length,
      this.ports.mintId,
    );
    this.plan = buildCaptionPlan({
      lines: this.lines,
      sourceKey: this.sourceKey,
      frame: this.frame,
      placement: this.placement,
      cuts: this.cutPlan.cuts,
      ids: this.ids,
    });
    this.steps = revealSteps(this.plan, this.source);
  }

  /**
   * Recompute from the baseline, coalesced into one frame.
   *
   * Always from the baseline: `placeCaptionRow` and `removeRanges` are not
   * idempotent, so applying the plan to the document already on screen would
   * cut twice and place two of every caption.
   *
   * Coalesced because the caller is a keystroke handler. A rebuild is one pass
   * over the captions and `placeNewElement` normalises the document on each of
   * them, so at typing speed the difference between one per frame and one per
   * key is the difference between free and measurable.
   */
  private requestRebuild(): void {
    if (this.phase === "revealing") {
      // An edit mid-reveal means the user is ahead of the animation. Finish it
      // rather than restarting it under them.
      this.settleNow();
    }
    this.rebuildPending = true;
    this.schedule();
  }

  private rebuildNow(): void {
    const baseline = this.baseline;
    if (baseline == null) {
      return;
    }
    this.rebuildPending = false;
    this.rebuildPlan();
    this.projection = advanceProjection(
      startProjection(baseline),
      this.plan!,
      this.steps,
      this.source,
      this.steps.length,
    );
    this.ports.document.preview(this.projection.doc);
  }

  /** Run the reveal to its end, now, without waiting for frames. */
  private settleNow(): void {
    this.cancelFrame();
    if (this.phase === "revealing") {
      this.setPhase("live");
      this.advanceTo(this.steps.length);
    }
  }

  private tick(): void {
    this.frameHandle = null;

    if (this.rebuildPending) {
      this.rebuildNow();
    }

    if (this.phase === "revealing") {
      const elapsed = this.ports.now() - this.revealStartedAt;
      this.advanceTo(stepsDueAt(elapsed, this.steps.length));
      if (revealDone(elapsed, this.steps.length)) {
        this.setPhase("live");
      } else {
        this.schedule();
      }
    }
  }

  private advanceTo(upTo: number): void {
    const plan = this.plan;
    const projection = this.projection;
    if (plan == null || projection == null) {
      return;
    }

    const next = advanceProjection(
      projection,
      plan,
      this.steps,
      this.source,
      upTo,
    );
    // Identity means no step was due since the last frame, which happens
    // whenever the display outruns the reveal's own pace. Writing anyway would
    // wake every subscriber to redraw a picture that cannot have changed.
    if (next === projection) {
      return;
    }
    this.projection = next;
    this.ports.document.preview(next.doc);
  }

  private schedule(): void {
    if (this.frameHandle != null) {
      return;
    }
    this.frameHandle = this.ports.scheduler.request(() => this.tick());
  }

  private cancelFrame(): void {
    if (this.frameHandle != null) {
      this.ports.scheduler.cancel(this.frameHandle);
      this.frameHandle = null;
    }
  }

  /** The one place the lock is released. Both exits go through it. */
  private finish(): void {
    this.cancelFrame();
    this.rebuildPending = false;
    this.setPhase("idle");
    this.projection = null;
    this.plan = null;
    this.steps = [];
    this.ids = null;
    this.baseline = null;
    this.sourceKey = null;
    this.source = undefined;
    this.cutPlan = EMPTY_CUT_PLAN;
    this.lines = [];
    this.ports.lock.unlock();
  }

  private setPhase(phase: CaptionSessionPhase): void {
    if (this.phase === phase) {
      return;
    }
    this.phase = phase;
    this.ports.onPhase?.(phase);
  }
}

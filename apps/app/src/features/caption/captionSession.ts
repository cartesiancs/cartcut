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
 * ## Several clips
 *
 * The panel can caption several clips in one session. Each is held as the
 * session first saw it and cut against its own source ranges; the projection
 * keeps the cuts per track (`captionProjection.ts`). Two guards run at `start`,
 * against the document as it was: a clip whose track is gone or is not a
 * video or audio track, and a clip overlapping another chosen clip on its own
 * track, keeps its captions and loses its cuts. Tracks are not supposed to hold
 * overlapping clips, but only the editing ops keep that true and a project can
 * arrive without it, and the ripple arithmetic is wrong for an overlap.
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
import {
  isDynamicElement,
  sourceTimeAt,
  spanOf,
} from "../timeline/geometry";
import { overlaps } from "../timeline/overlap";
import { shiftPoint, unshiftPoint } from "../timeline/rippleMap";
import { trackById, type TimelineDocument } from "../timeline/tracks";
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
import type { CaptionSourcePosition } from "./playheadPort";
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

/**
 * What to cut from one clip, in **source** milliseconds.
 *
 * Source rather than timeline, and unplanned rather than planned, because the
 * two things that feed it are both authored against the file: the silences the
 * sweep found, and the span of every line the user has struck out. The session
 * plans them, which is also what keeps "resolve the clip before cutting it"
 * true past the first change: the baseline clip is held here, and
 * `doc.elements[key]` is a *piece* of it by then, or gone.
 */
export type CaptionClipRanges = { key: string; sourceRanges: TimeRange[] };

/** One chosen clip, as the panel hands it over. */
export type CaptionClipInput = CaptionClipRanges & {
  /** The clip, read **before** anything cuts it. */
  source: TimelineElement | undefined;
};

/** What the panel hands over once it has words and silences. */
export type CaptionSessionStart = {
  lines: CaptionLine[];
  /** In the order the user chose them. */
  clips: CaptionClipInput[];
  frame: CaptionFrame;
  placement: CaptionPlacement;
};

/** What the panel hands over on every later change. */
export type CaptionSessionUpdate = {
  lines: CaptionLine[];
  placement: CaptionPlacement;
  /**
   * Source ms per clip, rebuilt by the panel from its lines and its toggle. A
   * clip left out has nothing to cut; a key the session does not hold is
   * ignored.
   */
  ranges: CaptionClipRanges[];
};

export type CaptionSessionPhase = "idle" | "revealing" | "live";

/** A clip whose cuts were refused at `start`, and why. See the header. */
export type CaptionRefusal = { key: string; reason: "overlaps" | "noLane" };

type HeldClip = {
  key: string;
  source: TimelineElement | undefined;
  cutPlan: CutPlan;
};

export class CaptionSession {
  private phase: CaptionSessionPhase = "idle";
  private baseline: TimelineDocument | null = null;
  private clips: HeldClip[] = [];
  private refusals: CaptionRefusal[] = [];
  private frame: CaptionFrame = { w: 1920, h: 1080 };
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

  /**
   * The cuts as they will be made, by the track they are made on: timeline ms,
   * snapped, ascending, each clip's own list laid end to end.
   */
  get cutsByTrack(): ReadonlyMap<string, TimeRange[]> {
    const lanes = new Map<string, TimeRange[]>();
    for (const clip of this.clips) {
      const trackId = clip.source?.trackId;
      if (trackId == null || clip.cutPlan.cuts.length === 0) {
        continue;
      }
      // `planCuts` answers descending; this answers ascending, like the plan.
      const ascending = [...clip.cutPlan.cuts].reverse();
      lanes.set(trackId, [...(lanes.get(trackId) ?? []), ...ascending]);
    }
    for (const cuts of lanes.values()) {
      cuts.sort((a, b) => a.startMs - b.startMs);
    }
    return lanes;
  }

  /**
   * The clips whose ranges would leave no footage at all.
   *
   * Their cuts are dropped and their captions placed anyway. That half is
   * recoverable by hand; an emptied track is not, and it would take every
   * caption's anchor with it. Other clips are cut as asked.
   */
  get coveredClips(): readonly string[] {
    return this.clips
      .filter((clip) => clip.cutPlan.coversWholeClip)
      .map((clip) => clip.key);
  }

  /** The clips that were refused cuts at `start`. See the header. */
  get refusedClips(): readonly CaptionRefusal[] {
    return this.refusals;
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
    const baseline = this.ports.document.read();
    this.baseline = baseline;

    const seen = new Set<string>();
    this.clips = [];
    for (const clip of input.clips) {
      if (seen.has(clip.key)) {
        continue;
      }
      seen.add(clip.key);
      this.clips.push({
        key: clip.key,
        source: clip.source,
        cutPlan: EMPTY_CUT_PLAN,
      });
    }
    this.refusals = refusalsOf(this.clips, baseline);

    this.frame = input.frame;
    this.lines = input.lines;
    this.placement = input.placement;
    this.ids = null;
    this.replan(input.clips);

    this.ports.lock.lock();
    this.setPhase("revealing");
    this.rebuildPlan();

    this.projection = startProjection(baseline);
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
    this.replan(input.ranges);
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
   * Where a moment of one clip's file sits on the timeline now, or null for a
   * clip the session does not hold.
   *
   * What the panel's word chips seek to. Two conversions, in this order: the
   * clip's own trim and speed, then the cuts on its track. Doing them the other
   * way round would ripple a time that is not on the timeline yet.
   */
  timelineMsOf(key: string, sourceMs: number): number | null {
    const clip = this.clips.find((candidate) => candidate.key === key);
    if (clip == null) {
      return null;
    }
    const onOriginal = captionToTimeline(
      { startTime: sourceMs, duration: 1 },
      clip.source,
    ).startTime;
    return shiftPoint(onOriginal, this.laneCutsOf(clip));
  }

  /**
   * The inverse, for the highlight: every chosen clip whose footage is under
   * the playhead, and where in its file.
   *
   * Answers in **seconds**, because that is what `lines.ts` counts in and what
   * `activeAt` compares against. Each clip undoes its own track's cuts and is
   * answered only if the instant lands inside the clip as it originally was, so
   * the gap between two clips answers nothing and the instant a cut closes
   * onto the next clip answers that clip.
   */
  sourcePositionsOf(timelineMs: number): CaptionSourcePosition[] {
    const out: CaptionSourcePosition[] = [];
    for (const clip of this.clips) {
      const source = clip.source;
      if (source == null || !isDynamicElement(source)) {
        continue;
      }
      const onOriginal = unshiftPoint(timelineMs, this.laneCutsOf(clip));
      const span = spanOf(source);
      if (onOriginal >= span.start && onOriginal < span.end) {
        out.push({
          key: clip.key,
          seconds: sourceTimeAt(source, onOriginal) / 1000,
        });
      }
    }
    return out;
  }

  // --------------------------------------------------------------- internals

  private laneCutsOf(clip: HeldClip): TimeRange[] {
    const trackId = clip.source?.trackId;
    return trackId == null ? [] : (this.plan?.lanes.get(trackId) ?? []);
  }

  /**
   * Turn the panel's source ranges into the cuts that will be made.
   *
   * Against each clip as the session first saw it, never as it stands: by the
   * second change the original id names a piece of the clip or nothing at all,
   * and `planCuts` would answer `EMPTY_CUT_PLAN` or clamp to the wrong window.
   */
  private replan(ranges: readonly CaptionClipRanges[]): void {
    // The first entry for a key wins, the same rule `start` keeps for clips.
    const byKey = new Map<string, TimeRange[]>();
    for (const entry of ranges) {
      if (!byKey.has(entry.key)) {
        byKey.set(entry.key, entry.sourceRanges);
      }
    }
    const refused = new Set(this.refusals.map((refusal) => refusal.key));
    for (const clip of this.clips) {
      if (refused.has(clip.key)) {
        clip.cutPlan = EMPTY_CUT_PLAN;
        continue;
      }
      const plan = planCuts(byKey.get(clip.key) ?? [], clip.source, this.ports.snap);
      clip.cutPlan = plan.coversWholeClip ? { ...plan, cuts: [] } : plan;
    }
  }

  private rebuildPlan(): void {
    this.ids = mintSessionIds(
      this.ids,
      this.lines,
      new Map(this.clips.map((clip) => [clip.key, clip.cutPlan.cuts.length])),
      this.ports.mintId,
    );
    this.plan = buildCaptionPlan({
      lines: this.lines,
      clips: this.clips.map((clip) => ({
        key: clip.key,
        source: clip.source,
        cuts: clip.cutPlan.cuts,
      })),
      frame: this.frame,
      placement: this.placement,
      ids: this.ids,
    });
    this.steps = revealSteps(this.plan);
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

    const next = advanceProjection(projection, plan, this.steps, upTo);
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
    this.clips = [];
    this.refusals = [];
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

/**
 * The clips that may not be cut, judged against the document as it was.
 *
 * Both halves of an overlapping pair are refused: neither can be cut without
 * the ripple arithmetic mispredicting where the other went.
 */
function refusalsOf(
  clips: readonly HeldClip[],
  doc: TimelineDocument,
): CaptionRefusal[] {
  const reasons = new Map<string, CaptionRefusal["reason"]>();
  const byTrack = new Map<string, { key: string; span: { start: number; end: number } }[]>();

  for (const clip of clips) {
    const source = clip.source;
    if (source == null || !isDynamicElement(source)) {
      continue;
    }
    const track = trackById(doc, source.trackId);
    if (track == null || (track.kind !== "video" && track.kind !== "audio")) {
      reasons.set(clip.key, "noLane");
      continue;
    }
    const list = byTrack.get(track.id) ?? [];
    list.push({ key: clip.key, span: spanOf(source) });
    byTrack.set(track.id, list);
  }

  for (const list of byTrack.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (overlaps(list[i].span, list[j].span)) {
          reasons.set(list[i].key, "overlaps");
          reasons.set(list[j].key, "overlaps");
        }
      }
    }
  }

  return clips
    .filter((clip) => reasons.has(clip.key))
    .map((clip) => ({ key: clip.key, reason: reasons.get(clip.key)! }));
}

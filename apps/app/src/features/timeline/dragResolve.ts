/**
 * What a drag gesture means, as a pure function.
 *
 * `dragMachine` decides *which* gesture is happening; this decides *where it
 * lands*. The two were separated because they answer different questions, but
 * only the first had ever been extracted — the second lived in
 * `elementTimelineCanvas.applyDrag`, a method on a Lit component, and so was
 * the one piece of real decision logic in the timeline that no test could
 * reach. Frame quantization is the most delicate thing that logic has ever
 * done, which made moving it out a precondition rather than a tidy-up.
 *
 * Two layers decide a clip's resting place, and they compose in a specific
 * order:
 *
 *   1. **Edge snapping** (`snapping.ts`) — pull the dragged span onto a
 *      neighbour's edge, the playhead, or zero, within a *pixel* tolerance.
 *   2. **Frame quantization** — otherwise, put it on the nearest frame.
 *
 * Snapping wins when it fires. Both rules are usually the same answer, since a
 * frame-aligned world has frame-aligned edges; where they differ — a clip
 * imported or edited before this existed — adjacency is the stronger promise.
 * Splitting a clip produces two halves that touch exactly, and re-quantizing
 * one of them onto a grid its neighbour is not on would open a sub-frame gap:
 * one frame of background flashing through, in the export, at every cut.
 *
 * The tolerance staying in pixels is what makes the handover automatic. At
 * maximum zoom ten pixels is a fifth of a frame, so snapping can only fire when
 * quantization would have chosen the same edge anyway; zoomed out, ten pixels
 * is hundreds of milliseconds and snapping does all the work.
 *
 * Layer 2 asks *who* before it fires. The grid is a picture constraint — see
 * `frames.ts#isFrameLocked` — so a drag carrying nothing but audio skips it and
 * comes to rest wherever the pointer put it, to the millisecond. Layer 1 still
 * runs: a magnet onto a neighbour's edge is adjacency, not a grid, and lining
 * sound up with a cut is the thing an audio drag most often means.
 */

import {
  ADJACENCY_EPSILON_MS,
  pxToMsSigned,
  spanEnd,
  spanLength,
  spanStart,
} from "./geometry";
import {
  frameToMs,
  isFrameLocked,
  msToFrame,
  msToFrameCeil,
  snapMsToFrame,
} from "./frames";
import { collectSnapPoints, snapEdge, snapSpan } from "./snapping";
import { trackDeltaFor } from "./dragMachine";
import type { TimelineDocument } from "./tracks";

/** How close, in px, an edge must come before it snaps. */
export const SNAP_TOLERANCE_PX = 10;

/**
 * Below this, a delta is float noise rather than an edit.
 *
 * The old code compared the applied delta against `0` exactly, which was sound
 * when it was always an integer. Quantized deltas are differences of two
 * doubles and land a few times 1e-11 away from zero when they mean zero, so the
 * comparison needs a floor — set far above that noise and far below anything a
 * pointer can express.
 */
const NOOP_EPSILON_MS = 1e-6;

/**
 * How far to travel, rounded to a whole number of frames, without crossing zero.
 *
 * The clamp is `ceil` rather than `max(0, …)` on the result: taking the
 * shortest travel that still keeps the anchor at or after zero preserves the
 * whole-frame property, where clamping the destination afterwards would break
 * it — and breaking it is exactly what this function exists to avoid.
 */
function travelInWholeFrames(
  fromMs: number,
  toMs: number,
  fps: number,
): number {
  const wanted = msToFrame(toMs - fromMs, fps);
  const shortest = msToFrameCeil(-fromMs, fps);
  return frameToMs(Math.max(wanted, shortest), fps);
}

export type MovePlan =
  | { kind: "none" }
  | {
      kind: "move";
      /** Timeline ms to shift every dragged clip by. */
      appliedMs: number;
      /** Rows to travel, already zero unless the clip came free. */
      trackDelta: number;
      /** Time to draw a guide line at, if an edge snapped. */
      snapGuideMs: number | null;
    };

export type TrimPlan =
  | { kind: "none" }
  | {
      kind: "trim";
      /** Timeline ms to move the grabbed edge by. */
      trimMs: number;
      /**
       * Time to draw a guide line at, if the edge snapped.
       *
       * Aspirational: `clipOps` clamps after this, so pass it through
       * `confirmTrimGuide` with the resulting document before drawing it.
       */
      snapGuideMs: number | null;
    };

export type ResolveMoveInput = {
  base: TimelineDocument;
  /** The clip actually under the pointer; the rest of the selection follows it. */
  primaryId: string;
  dragIds: string[];
  dxPx: number;
  dyPx: number;
  /** Whether the hold (or Alt) unlocked vertical movement. */
  free: boolean;
  range: number;
  fps: number;
  playheadMs: number;
  trackPitch: number;
  tolerancePx?: number;
  /**
   * Off only for testing the pre-quantization behaviour.
   *
   * A permission, not an instruction: an all-audio drag is unquantized whatever
   * this says. Leaving it on is what the app does.
   */
  quantize?: boolean;
};

export function resolveMove(input: ResolveMoveInput): MovePlan {
  const {
    base,
    primaryId,
    dragIds,
    dxPx,
    dyPx,
    free,
    range,
    fps,
    playheadMs,
    trackPitch,
    quantize = true,
  } = input;

  const primary = base.elements[primaryId];
  if (primary == null) {
    return { kind: "none" };
  }

  // The grid applies to the whole gesture or to none of it, because one delta
  // moves every dragged clip. One picture clip in the selection keeps it on:
  // dragging a video together with its detached audio has to preserve their
  // relative sync, so they must share a delta, and it is the picture that has a
  // say in what that delta may be.
  const onGrid =
    quantize &&
    [primaryId, ...dragIds].some((id) => {
      const element = base.elements[id];
      return element != null && isFrameLocked(element);
    });

  // ...and *how* it applies depends on which clip the pointer is holding, since
  // the anchor is the one whose position the grid gets to choose.
  const anchorLocked = isFrameLocked(primary);

  const trackDelta = free ? trackDeltaFor(dyPx, trackPitch) : 0;

  // A press that has not travelled must stay a press. Without this the pointer
  // going down on a clip that predates frame alignment would quantize it on the
  // spot — an edit the user never asked for, arriving before they had moved.
  if (dxPx === 0 && trackDelta === 0) {
    return { kind: "none" };
  }

  const deltaMs = pxToMsSigned(dxPx, range);
  const desiredMs = Math.max(0, spanStart(primary) + deltaMs);

  const snapped = snapSpan(
    desiredMs,
    spanLength(primary),
    collectSnapPoints(base, { excludeIds: dragIds, playheadMs }),
    range,
    input.tolerancePx ?? SNAP_TOLERANCE_PX,
    primary.trackId,
  );

  let targetMs: number;
  if (!onGrid) {
    // Audio, alone. Wherever the pointer left it, edge included.
    targetMs = snapped.startMs;
  } else if (!anchorLocked) {
    // The pointer is holding audio, and audio is not the grid's to place — but
    // the picture coming with it is. So quantize the *distance travelled*
    // instead of the destination: a whole number of frames of travel leaves
    // every already-aligned clip in the selection exactly as aligned as it was,
    // and leaves the audio on whatever phase it chose.
    //
    // This is the one case where quantizing the delta is right, and it is right
    // for the reason it is wrong everywhere else. Elsewhere the phase it
    // preserves is drift nobody asked for; here it is the whole point.
    //
    // It also outranks the edge snap, which is the only place in this module
    // where anything does. The snap has chosen where to aim; honouring it to
    // the millisecond would put the audio flush against a neighbour and knock
    // every picture clip in the selection off the grid to do it. An audio clip
    // meeting an edge exactly is a nicety. A video clip landing between two
    // frames is a frame of background at the cut.
    targetMs =
      spanStart(primary) +
      travelInWholeFrames(spanStart(primary), snapped.startMs, fps);
  } else if (snapped.hit != null) {
    targetMs = snapped.startMs;
  } else {
    targetMs = Math.max(0, snapMsToFrame(snapped.startMs, fps));
  }

  // Honoured, or aimed at and then rounded away from. Only the first draws a
  // guide — a line the clip visibly did not land on reads as a bug.
  const snappedToEdge = snapped.hit != null && targetMs === snapped.startMs;

  // Both targets are exact — a frame instant, or a neighbour's actual edge — so
  // neither may be rounded. Rounding the *delta* is what the old code did, and
  // it silently missed the target it had just chosen: snapping a clip at
  // 5000ms onto an edge at 1988.888 rounded the delta to -3011 and landed on
  // 1989, a tenth of a millisecond short of the adjacency it was asked for.
  // That was invisible while every clip sat on a whole millisecond and is not
  // once two of every three frames fall between them.
  //
  // The rounding survives only where the target came straight from pixel
  // arithmetic and there is nothing exact to preserve — the unquantized path,
  // and an audio drag that found no edge. An audio drag which *did* find one is
  // exact like any other: the edge is the same promise whoever asked for it,
  // and rounding to the nearest millisecond would land beside it.
  //
  // What gets rounded there is the delta, not the resting place, so a clip
  // already sitting between two milliseconds keeps that phase. A clip parked
  // exactly on a cut should not lurch a half-millisecond off it the first time
  // it is nudged, which rounding the position would do.
  const preserveTarget = onGrid || (quantize && snappedToEdge);
  const rawApplied = targetMs - spanStart(primary);
  const appliedMs = preserveTarget ? rawApplied : Math.round(rawApplied);

  // A gesture that moves nothing must produce nothing: `moveClips` builds a
  // fresh document even for a zero delta, so the identity check `withCheckpoint`
  // relies on would pass and an undo step would be recorded for a wiggle.
  if (Math.abs(appliedMs) < NOOP_EPSILON_MS && trackDelta === 0) {
    return { kind: "none" };
  }

  return {
    kind: "move",
    appliedMs,
    trackDelta,
    snapGuideMs: snappedToEdge ? (snapped.hit?.ms ?? null) : null,
  };
}

export type ResolveTrimInput = {
  base: TimelineDocument;
  elementId: string;
  edge: "start" | "end";
  dxPx: number;
  range: number;
  fps: number;
  /** Omitted means the playhead is not a snap candidate. */
  playheadMs?: number;
  tolerancePx?: number;
  quantize?: boolean;
};

/**
 * Where a trim handle lets go.
 *
 * The same two layers as `resolveMove`, in the same order and for the same
 * reasons: the grabbed edge snaps to a neighbour's edge, the playhead or zero
 * within a pixel tolerance, and falls back to the frame grid when nothing is in
 * range. Lengthening a clip until it meets the next one is the commonest thing
 * anyone does with these handles, and doing it by eye a frame at a time is what
 * this replaces — a neighbour that predates frame alignment could not be met at
 * all.
 *
 * The grid still applies to audio here. That exemption is a *drag* rule
 * (`frames.ts#isFrameLocked`, and the note in CLAUDE.md); trims quantize
 * everything. Snapping is the separate layer, so an audio handle gains the
 * magnet without gaining the exemption.
 *
 * When nothing snaps, the edge is quantized, not the delta. Quantizing a *delta*
 * preserves whatever sub-frame phase the edge already had — drag a misaligned
 * clip's handle and it stays misaligned forever. Quantizing the resulting *edge*
 * puts it on the grid and keeps it there.
 *
 * `trimClipStart` / `trimClipEnd` clamp against the source file, timeline zero
 * and the neighbouring clip, so a trim that runs into one of those comes to rest
 * wherever the clamp says — possibly off-grid. That is correct: a hard boundary
 * outranks a preference, and the boundaries themselves are frame-aligned in a
 * document that has been edited under these rules.
 */
export function resolveTrim(input: ResolveTrimInput): TrimPlan {
  const {
    base,
    elementId,
    edge,
    dxPx,
    range,
    fps,
    playheadMs,
    quantize = true,
  } = input;

  const element = base.elements[elementId];
  if (element == null) {
    return { kind: "none" };
  }

  const deltaMs = pxToMsSigned(dxPx, range);
  const edgeMs = edge === "start" ? spanStart(element) : spanEnd(element);
  const desiredMs = edgeMs + deltaMs;

  // The clip being trimmed is excluded, which also stops the moving edge
  // snapping to the pinned one: a clip cannot collapse onto itself, and its own
  // far edge is the one candidate that would always be reachable.
  const snapped = snapEdge(
    desiredMs,
    collectSnapPoints(base, { excludeIds: [elementId], playheadMs }),
    range,
    input.tolerancePx ?? SNAP_TOLERANCE_PX,
    element.trackId,
  );

  // Snapping wins, and the edge it found is taken verbatim — re-quantizing it
  // would reopen the sub-frame gap this module's header warns about. Unlike
  // `resolveMove` there is no third rule that can overrule the snap afterwards,
  // so a hit is always honoured and `snapGuideMs` needs no suppression here.
  const targetMs =
    snapped.hit != null
      ? snapped.ms
      : quantize
        ? snapMsToFrame(desiredMs, fps)
        : desiredMs;

  const rawTrim = targetMs - edgeMs;
  const trimMs = quantize ? rawTrim : Math.round(rawTrim);

  if (Math.abs(trimMs) < NOOP_EPSILON_MS) {
    return { kind: "none" };
  }

  return { kind: "trim", trimMs, snapGuideMs: snapped.hit?.ms ?? null };
}

/**
 * The trim guide, kept only if the edge actually arrived.
 *
 * `resolveTrim` chooses a target; `trimClipStart`/`trimClipEnd` then clamp it
 * against the neighbouring clip, timeline zero, `MIN_TIMELINE_MS` and — the case
 * that matters here — the source file's own head and tail room. A clip with two
 * seconds of footage left cannot reach a neighbour five seconds away, and
 * drawing the line anyway is how a correct edit reads as a broken one. Same rule
 * `resolveMove` keeps with `snappedToEdge`, enforced one step later because for
 * a trim the clamp lives downstream of the resolver.
 *
 * The neighbour clamp needs no special case: its limit *is* the snap candidate,
 * so an edge stopped by it has landed exactly where the guide says.
 *
 * `ADJACENCY_EPSILON_MS` rather than `===` because a clamped edge reaches the
 * document as a sum of doubles, and a sped-up clip's span is `duration / speed`,
 * which reconstructs its target only to within a rounding error.
 */
export function confirmTrimGuide(
  doc: TimelineDocument,
  elementId: string,
  edge: "start" | "end",
  guideMs: number | null,
): number | null {
  if (guideMs == null) {
    return null;
  }
  const element = doc.elements[elementId];
  if (element == null) {
    return null;
  }
  const landedMs = edge === "start" ? spanStart(element) : spanEnd(element);
  return Math.abs(landedMs - guideMs) <= ADJACENCY_EPSILON_MS ? guideMs : null;
}

export type ResolveTransitionResizeInput = {
  base: TimelineDocument;
  transitionId: string;
  /** Which end is under the pointer. */
  edge: "start" | "end";
  dxPx: number;
  range: number;
  fps: number;
  quantize?: boolean;
};

export type TransitionResizePlan =
  | { kind: "none" }
  /** The length to ask for. `setTransitionDuration` clamps it to the handles. */
  | { kind: "duration"; durationMs: number };

/**
 * Where a transition's length handle lets go.
 *
 * A transition is anchored to its cut, so dragging either end changes only its
 * *length*. Which end matters because the two grow it in opposite directions
 * and by different amounts:
 *
 *  - A centred transition extends both ways at once, so moving one end by `d`
 *    changes the duration by `2d` — otherwise the badge would appear to lag the
 *    pointer by half.
 *  - An `end`-aligned transition has its right edge pinned to the cut, so only
 *    the left handle does anything, and it changes the duration one for one.
 *  - A `start`-aligned one is the mirror image.
 *
 * The result is a *request*: `setTransitionDuration` re-resolves it against
 * what the source handles can actually supply and clamps it there, recording
 * the ask in `requestedDuration`. So dragging past the available footage stops
 * the badge growing but is not lost — trimming a neighbour later gives it back.
 */
export function resolveTransitionResize(
  input: ResolveTransitionResizeInput,
): TransitionResizePlan {
  const {
    base,
    transitionId,
    edge,
    dxPx,
    range,
    fps,
    quantize = true,
  } = input;

  const element = base.elements[transitionId];
  if (element == null || element.filetype !== "transition") {
    return { kind: "none" };
  }

  // Dragging the left edge leftwards lengthens, so its sign is inverted.
  const directed = edge === "start" ? -dxPx : dxPx;
  const deltaMs = pxToMsSigned(directed, range);

  const scale = element.alignment === "center" ? 2 : 1;
  // An aligned transition has one edge pinned to the cut, and dragging the
  // pinned one must do nothing rather than move the badge off its cut.
  if (
    (element.alignment === "end" && edge === "end") ||
    (element.alignment === "start" && edge === "start")
  ) {
    return { kind: "none" };
  }

  const rawDuration = element.duration + deltaMs * scale;
  // Quantize the length, not the delta — the same reasoning as `resolveTrim`.
  // A duration is a difference of two frame-aligned instants, so snapping it
  // keeps both edges on the grid wherever the cut happens to be.
  const durationMs = quantize
    ? snapMsToFrame(rawDuration, fps)
    : Math.round(rawDuration);

  if (Math.abs(durationMs - element.duration) < NOOP_EPSILON_MS) {
    return { kind: "none" };
  }

  return { kind: "duration", durationMs: Math.max(0, durationMs) };
}

/**
 * What a drag shows after one more pointer event.
 *
 * Every event is resolved afresh from the gesture's base, and there are three
 * different answers an event can produce — which must not be confused:
 *
 *   - **No change** (`next` is `null`): the resolver answered `none`, because
 *     the pointer's travel resolves to where the clip started. That is an
 *     answer, so the preview goes back to the base.
 *   - **Declined** (`next === base`): what that means depends on the op, so
 *     the caller says. `moveClips` *refuses* — an overlap, a row of another
 *     kind — and there the previous frame is held (`"hold"`), so a blocked
 *     drag rests against whatever is in the way instead of jumping home.
 *     `trimClipStart`/`trimClipEnd` and `setTransitionDuration` never refuse:
 *     they *clamp*, so identity from them means the clamp cancelled the whole
 *     edit — the base, not a reason to stay put (`"base"`).
 *   - **Changed**: the op's result becomes the candidate.
 *
 * Holding the previous frame where the answer was really "the base" is what
 * froze a clip a few frames short of 0s: drag a clip that starts at 0 away and
 * back, and from the moment the pointer passed its origin every event answered
 * `none`, so the clip stayed wherever the last *moving* event had left it, and
 * releasing committed that. A trimmed edge pulled back past its clamp froze
 * the same way.
 *
 * `null` back means "show the base", which is also what keeps a gesture that
 * ends where it started free: nothing is pending, so no undo step is recorded.
 */
export function nextDragPreview(
  previous: TimelineDocument | null,
  base: TimelineDocument,
  next: TimelineDocument | null,
  onIdentity: "hold" | "base",
): TimelineDocument | null {
  if (next == null) {
    return null;
  }
  if (next === base) {
    return onIdentity === "hold" ? previous : null;
  }
  return next;
}

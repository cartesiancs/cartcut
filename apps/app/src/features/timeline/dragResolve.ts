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
 */

import { pxToMsSigned, spanEnd, spanLength, spanStart } from "./geometry";
import { snapMsToFrame } from "./frames";
import { collectSnapPoints, snapSpan } from "./snapping";
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

export type TrimPlan = { kind: "none" } | { kind: "trim"; trimMs: number };

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
  /** Off only for testing the pre-quantization behaviour. */
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

  const snappedToEdge = snapped.hit != null;
  const targetMs =
    snappedToEdge || !quantize
      ? snapped.startMs
      : Math.max(0, snapMsToFrame(snapped.startMs, fps));

  // Both targets are exact — a frame instant, or a neighbour's actual edge — so
  // neither may be rounded. Rounding the *delta* is what the old code did, and
  // it silently missed the target it had just chosen: snapping a clip at
  // 5000ms onto an edge at 1988.888 rounded the delta to -3011 and landed on
  // 1989, a tenth of a millisecond short of the adjacency it was asked for.
  // That was invisible while every clip sat on a whole millisecond and is not
  // once two of every three frames fall between them.
  //
  // The rounding survives only on the unquantized path, where the target came
  // straight from pixel arithmetic and there is nothing exact to preserve.
  const rawApplied = targetMs - spanStart(primary);
  const appliedMs = quantize ? rawApplied : Math.round(rawApplied);

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
    snapGuideMs: snapped.hit?.ms ?? null,
  };
}

export type ResolveTrimInput = {
  base: TimelineDocument;
  elementId: string;
  edge: "start" | "end";
  dxPx: number;
  range: number;
  fps: number;
  quantize?: boolean;
};

/**
 * Where a trim handle lets go.
 *
 * The edge is quantized, not the delta. Quantizing a *delta* preserves whatever
 * sub-frame phase the edge already had — drag a misaligned clip's handle and it
 * stays misaligned forever. Quantizing the resulting *edge* puts it on the grid
 * and keeps it there.
 *
 * `trimClipStart` / `trimClipEnd` clamp against the source file, timeline zero
 * and the neighbouring clip, so a trim that runs into one of those comes to rest
 * wherever the clamp says — possibly off-grid. That is correct: a hard boundary
 * outranks a preference, and the boundaries themselves are frame-aligned in a
 * document that has been edited under these rules.
 */
export function resolveTrim(input: ResolveTrimInput): TrimPlan {
  const { base, elementId, edge, dxPx, range, fps, quantize = true } = input;

  const element = base.elements[elementId];
  if (element == null) {
    return { kind: "none" };
  }

  const deltaMs = pxToMsSigned(dxPx, range);
  const edgeMs = edge === "start" ? spanStart(element) : spanEnd(element);
  const targetMs = quantize
    ? snapMsToFrame(edgeMs + deltaMs, fps)
    : edgeMs + deltaMs;

  const rawTrim = targetMs - edgeMs;
  const trimMs = quantize ? rawTrim : Math.round(rawTrim);

  if (Math.abs(trimMs) < NOOP_EPSILON_MS) {
    return { kind: "none" };
  }

  return { kind: "trim", trimMs };
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

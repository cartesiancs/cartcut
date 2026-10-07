/**
 * Auto-zoom: an input track in, a set of zoom moves out.
 *
 * This is the reason the recorder composes *after* the take rather than during
 * it. A zoom that begins when the cursor arrives is already late: the viewer
 * sees the move, then the zoom chases it. A zoom that begins half a second
 * *before* the cursor settles reads as though the camera knew, and there is no
 * way to know during a live capture. Loom and Screen Studio both record raw and
 * compose afterwards for exactly this; `LOOKAHEAD_MS` is where that decision is
 * spent.
 *
 * The shape of the answer is a small list of non-overlapping `ZoomSegment`s,
 * each with four instants (ease in, hold, ease out) rather than a value per
 * frame. Two reasons: a segment list is a few dozen numbers where a per-frame
 * track is tens of thousands (the same argument `serialize.ts` makes about not
 * returning `animation.ax`), and a segment is something a person can read in a
 * debug dump and say "that zoom is wrong" about.
 *
 * ## What this module knows, and what it deliberately does not
 *
 * **When** to zoom, **how deep**, and **toward what point of the capture**. It
 * has no idea how large the project frame is or what shape it is, so it decides
 * nothing about geometry: `recordFit.ts` owns that, `zoomCamera.ts` turns these
 * segments into a smoothed path, and `zoomKeyframes.ts` writes it to the clip.
 *
 * That split is why `clampCenter` and `visibleRectFor` are gone. They derived the
 * visible window as `frame / scale`, which assumes it has the *capture's* aspect;
 * under the cover fit the clip is actually drawn at it has the *project frame's*,
 * and the two differ by exactly the amount being cropped. Two clamps with
 * different assumptions is worse than one in the right place, and the one in the
 * right place is `recordFit.ts#clampAim`, which is asserted at three aspects.
 * They also described a `VideoFrame.visibleRect` composite pass that was never
 * built and now never will be: the zoom is keyframes on the clip, so it stays
 * editable and costs no second encode.
 *
 * Coordinates in are **frame pixels of the screen capture**. The aim out is a
 * **fraction of the capture**, because that is what survives a project whose
 * frame size changes afterwards.
 *
 * Pure, DOM-free, no store.
 */

import type { ZoomStrength } from "./recordSettings";
import type { CursorSample, PointerMark } from "./inputLog";

export type { CursorSample, PointerMark };

export type Size = { width: number; height: number };

/**
 * One zoom move.
 *
 * `inStart <= inEnd <= outStart <= outEnd`, and segments never overlap, so
 * `sampleZoom` can answer with a single scan and no blending between moves.
 */
export type ZoomSegment = {
  /** Zoom begins moving away from the resting pose. */
  inStart: number;
  /** Full `zoom` reached. */
  inEnd: number;
  /** Zoom begins returning. */
  outStart: number;
  /** Back at rest. */
  outEnd: number;
  /**
   * How far in, in **cover units**: 1 is "the picture exactly fills the frame".
   *
   * Never below 1. Below it the picture does not cover the frame and a pan would
   * slide it around inside its own padding; see `recordFit.ts#Z_COVER`.
   */
  zoom: number;
  /** Where to aim, as a fraction of the capture. */
  u: number;
  v: number;
};

/** How far through a move, and where it is going. */
export type ZoomView = {
  /** 0 at rest, 1 at full zoom. The caller blends its own resting pose with it. */
  progress: number;
  zoom: number;
  u: number;
  v: number;
};

export const RESTING_VIEW: ZoomView = { progress: 0, zoom: 1, u: 0.5, v: 0.5 };

/**
 * How far in a zoom may push.
 *
 * A range rather than a single number, because the depth that reads right depends
 * on how localized the activity is: a cluster of clicks on one button wants to
 * fill the frame with that button, and activity spread over half the screen wants
 * a nudge. `depthFor` picks within the range by fitting the cluster's own box.
 *
 * That is why the setting is a two-state `off`/`on` and not a strength. The depth
 * is already decided per move by the thing that earned it; a global "how hard"
 * dial was a second control over the same number, and the two could only ever
 * disagree.
 *
 * The minimum is never below 1: see `ZoomSegment.zoom`.
 *
 * The maximum is the depth nearly every move gets: a click or a dwell has a box
 * far smaller than the frame, so `depthFor` wants more than the range allows. And
 * the viewer compares it with the resting pose, not with `cover`: a 16:10 capture
 * in a 16:9 frame rests at about 0.82 cover, so a maximum of 2 read as a 2.4x
 * push and lost the context around the click. 1.5 is about 1.8x.
 */
const STRENGTH_RANGES: Record<ZoomStrength, { min: number; max: number }> = {
  off: { min: 1, max: 1 },
  on: { min: 1.1, max: 1.5 },
};

export function zoomRangeFor(strength: ZoomStrength): {
  min: number;
  max: number;
} {
  return STRENGTH_RANGES[strength] ?? STRENGTH_RANGES.off;
}

/**
 * How still the cursor has to be to count as settled, as a fraction of the
 * frame's shorter side.
 *
 * Deliberately generous. Somebody reading a paragraph moves the pointer in
 * small aimless arcs; somebody who has stopped to work on one control does not
 * hold it to the pixel. Too tight and a dwell never forms; too loose and the
 * whole take is one dwell.
 */
const DWELL_RADIUS_FRACTION = 0.06;

/** How long the cursor must stay settled before a zoom is earned. */
const MIN_DWELL_MS = 900;

/** How far ahead of the activity the zoom starts. The whole point of the module. */
const LOOKAHEAD_MS = 500;

/**
 * The least anticipation a move is still worth making separately.
 *
 * `packSegments` merges two clusters when the second's move cannot begin at least
 * this far before its own activity. Testing the *full* `LOOKAHEAD_MS` instead was
 * measurably wrong: on a real take three dwells 1.7s apart merged into a single
 * zoom over the whole clip because the first pair missed by 50ms, and that merge
 * then pushed the third into conflict as well. Losing most of the lookahead is a
 * slightly late zoom; losing all of it is a zoom that chases what it is for, and
 * only the second is worth giving up a move over.
 *
 * Four frames at 30fps.
 */
const MIN_LEAD_MS = 120;

/**
 * The shortest a move's hold may be cut to so the next one can start on time.
 *
 * Shortening the move in front is tried before merging, because a zoom that
 * arrives, sits for half a second and releases is still a move; only below about
 * this does it start reading as a flinch.
 */
const SHORT_HOLD_MS = 500;

/**
 * The longest run of activity that is still *one* thing to look at.
 *
 * The cap that stops merging cascading. Without it a take with a click every
 * second or so collapses into a single move: each pair is too close to be two
 * moves, merging makes the cluster longer, and a longer cluster conflicts with
 * the next one too. Measured against a real 37-second take, fourteen presses came
 * out as one 26-second zoom at 1.25x, which is neither a zoom nor the full frame.
 *
 * Past this the clusters stay separate even though the later one's move has to
 * start late. A zoom that arrives just after the click is worth having; a zoom
 * framed so wide it shows most of the screen is not.
 */
const MAX_CLUSTER_MS = 5000;

/** How long a zoom lingers after the activity stops. */
const HOLD_AFTER_MS = 700;

const EASE_IN_MS = 650;
const EASE_OUT_MS = 550;

/**
 * The shortest a zoom may hold at full scale.
 *
 * A move that zooms in and immediately back out is worse than no move: it reads
 * as a glitch rather than as emphasis.
 *
 * A **floor**, not a filter, which is the difference clicks make. A dwell is by
 * definition at least `MIN_DWELL_MS` long, so holding for the length of the
 * activity was always long enough; a click is instantaneous and would hold for
 * `HOLD_AFTER_MS` alone, which is less than this. Filtering on it would mean a
 * lone click, the clearest statement of interest there is, could never earn a
 * zoom at all.
 */
const MIN_HOLD_MS = 1200;

/** Two anchors closer than this in time are candidates for merging. */
const MERGE_GAP_MS = 1500;

/**
 * ...and close enough in space, as a fraction of the frame's shorter side.
 *
 * Merging on time alone would slide the frame between two distant points during
 * the hold, which is a pan nobody asked for.
 */
const MERGE_RADIUS_FRACTION = 0.12;

/**
 * Padding around a cluster's own box when fitting the depth.
 *
 * A zoom framed exactly on the box the clicks landed in puts the button against
 * the edge of the picture. A fifth of the frame on each side is enough to read
 * as "that area" rather than "that pixel".
 */
const CLUSTER_PADDING = 0.4;

/**
 * The most of the take that may be zoomed.
 *
 * A clip zoomed throughout is not an effect, it is a static crop with extra
 * steps, and the viewer loses the sense of where on the screen anything is. Past
 * this the weakest clusters are dropped.
 */
const MAX_ZOOMED_FRACTION = 0.7;

/** Smoothstep. Zero velocity at both ends, which is what stops a zoom snapping. */
export function smoothstep(t: number): number {
  const p = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return p * p * (3 - 2 * p);
}

/**
 * A stretch of interest, with the box the interest covered.
 *
 * `weight` is what `MAX_ZOOMED_FRACTION` drops by when there is too much to zoom
 * on: a click is a deliberate statement and a dwell is an inference, so when only
 * some of them can be kept the clicks are kept.
 */
export type Anchor = {
  start: number;
  end: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  weight: number;
  /**
   * How many deliberate presses are in here.
   *
   * The rule this exists for: **a click always earns a zoom.** A dwell is an
   * inference from the pointer sitting still and may be dropped when there is too
   * much to zoom at; a click is the user saying "this", and a plan that answers
   * nothing to it is the plan being wrong. Nothing below drops a cluster with a
   * click in it.
   */
  clicks: number;
};

type Dwell = { start: number; end: number; cx: number; cy: number };

/** Usable samples, in order. Anything unreadable is dropped, never thrown on. */
function cleanSamples(samples: readonly CursorSample[]): CursorSample[] {
  return samples
    .filter(
      (sample) =>
        sample != null &&
        Number.isFinite(sample.t) &&
        Number.isFinite(sample.x) &&
        Number.isFinite(sample.y),
    )
    .slice()
    .sort((a, b) => a.t - b.t);
}

/**
 * Find the stretches where the cursor stopped moving.
 *
 * Greedy and single-pass: extend the current run while every sample in it stays
 * within `radius` of the run's own centroid, and close the run when one does
 * not. Centroid rather than "within radius of the first sample", which would
 * let a slow drift walk the run across the screen a pixel at a time and call
 * the whole journey a dwell.
 */
export function findDwells(
  samples: readonly CursorSample[],
  frame: Size,
): Dwell[] {
  const ordered = cleanSamples(samples);
  if (ordered.length === 0) {
    return [];
  }

  const radius = Math.min(frame.width, frame.height) * DWELL_RADIUS_FRACTION;
  const dwells: Dwell[] = [];

  let start = 0;
  let sumX = 0;
  let sumY = 0;
  let count = 0;

  const close = (endIndex: number) => {
    if (count === 0) {
      return;
    }
    const first = ordered[start];
    const last = ordered[endIndex];
    if (last.t - first.t >= MIN_DWELL_MS) {
      dwells.push({
        start: first.t,
        end: last.t,
        cx: sumX / count,
        cy: sumY / count,
      });
    }
  };

  for (let index = 0; index < ordered.length; index += 1) {
    const sample = ordered[index];

    if (count > 0) {
      const cx = sumX / count;
      const cy = sumY / count;
      const dx = sample.x - cx;
      const dy = sample.y - cy;

      if (Math.hypot(dx, dy) > radius) {
        close(index - 1);
        start = index;
        sumX = 0;
        sumY = 0;
        count = 0;
      }
    }

    sumX += sample.x;
    sumY += sample.y;
    count += 1;
  }

  close(ordered.length - 1);

  return dwells;
}

/**
 * Everything worth zooming at, from both tracks.
 *
 * **A click is an anchor in its own right**, which is the single biggest
 * behavioural gap this closes. `MIN_DWELL_MS` is exactly what a click exists to
 * bypass: a decisive click on a button is the clearest possible statement of
 * interest, and until now it earned no zoom unless the pointer also loitered
 * there for most of a second. Screen Studio's own documentation names clicks as
 * the trigger and says plainly that it will not zoom where no click occurred.
 *
 * A **drag** is one anchor over the whole gesture, with a box covering its path,
 * so the frame follows a selection or a window move instead of ending the segment
 * the moment the cursor leaves its dwell radius.
 *
 * A **scroll** is an anchor where it happened: the eye is on the content going
 * past, and the pointer is usually still.
 *
 * Typing is not here yet. When it arrives it will *extend* whichever anchor it
 * lands in and never create one, because a key press has no position and the
 * reason the camera is in the right place while you type is that you clicked into
 * the field first.
 */
export function findAnchors(
  cursor: readonly CursorSample[],
  pointer: readonly PointerMark[],
  frame: Size,
): Anchor[] {
  const anchors: Anchor[] = [];

  for (const dwell of findDwells(cursor, frame)) {
    anchors.push({
      start: dwell.start,
      end: dwell.end,
      minX: dwell.cx,
      maxX: dwell.cx,
      minY: dwell.cy,
      maxY: dwell.cy,
      weight: 1,
      clicks: 0,
    });
  }

  const marks = pointer
    .filter(
      (mark) =>
        mark != null &&
        Number.isFinite(mark.t) &&
        Number.isFinite(mark.x) &&
        Number.isFinite(mark.y),
    )
    .slice()
    .sort((a, b) => a.t - b.t);

  // A drag is accumulated across consecutive `drag` marks and closed by the `up`
  // that follows, or by the next `down` if an `up` was lost: a monitor started
  // mid-gesture, or a window that swallowed the release.
  let drag: Anchor | null = null;

  const closeDrag = () => {
    if (drag != null) {
      anchors.push(drag);
      drag = null;
    }
  };

  for (const mark of marks) {
    if (mark.kind === "drag") {
      if (drag == null) {
        drag = markAnchor(mark, 3, 1);
      } else {
        drag.end = mark.t;
        drag.minX = Math.min(drag.minX, mark.x);
        drag.maxX = Math.max(drag.maxX, mark.x);
        drag.minY = Math.min(drag.minY, mark.y);
        drag.maxY = Math.max(drag.maxY, mark.y);
      }
      continue;
    }

    if (mark.kind === "up") {
      if (drag != null) {
        // The release is part of the path. Without it a drag that ends outside
        // the box its moves covered frames the gesture short of where it
        // finished, which for a window drag is the whole point of the gesture.
        drag.end = mark.t;
        drag.minX = Math.min(drag.minX, mark.x);
        drag.maxX = Math.max(drag.maxX, mark.x);
        drag.minY = Math.min(drag.minY, mark.y);
        drag.maxY = Math.max(drag.maxY, mark.y);
      }
      closeDrag();
      continue;
    }

    closeDrag();

    if (mark.kind === "down") {
      anchors.push(markAnchor(mark, 3, 1));
    } else if (mark.kind === "scroll") {
      // A scroll is deliberate too, but it is not a *place*: the pointer is
      // usually parked while the content moves under it, so it earns a zoom the
      // way a dwell does rather than the way a click does.
      anchors.push(markAnchor(mark, 2, 0));
    }
  }

  closeDrag();

  return anchors.sort((a, b) => a.start - b.start);
}

function markAnchor(mark: PointerMark, weight: number, clicks: number): Anchor {
  return {
    start: mark.t,
    end: mark.t,
    minX: mark.x,
    maxX: mark.x,
    minY: mark.y,
    maxY: mark.y,
    weight,
    clicks,
  };
}

/** Anchors close in time *and* in space become one. */
function cluster(anchors: readonly Anchor[], frame: Size): Anchor[] {
  const radius = Math.min(frame.width, frame.height) * MERGE_RADIUS_FRACTION;
  const clustered: Anchor[] = [];

  for (const anchor of anchors) {
    const previous = clustered[clustered.length - 1];

    if (previous == null) {
      clustered.push({ ...anchor });
      continue;
    }

    const gap = anchor.start - previous.end;
    const near =
      Math.hypot(
        centreOf(anchor).x - centreOf(previous).x,
        centreOf(anchor).y - centreOf(previous).y,
      ) <= radius;

    if (gap <= MERGE_GAP_MS && near) {
      previous.end = Math.max(previous.end, anchor.end);
      previous.minX = Math.min(previous.minX, anchor.minX);
      previous.maxX = Math.max(previous.maxX, anchor.maxX);
      previous.minY = Math.min(previous.minY, anchor.minY);
      previous.maxY = Math.max(previous.maxY, anchor.maxY);
      previous.weight += anchor.weight;
      previous.clicks += anchor.clicks;
      continue;
    }

    clustered.push({ ...anchor });
  }

  return clustered;
}

function centreOf(anchor: Anchor): { x: number; y: number } {
  return {
    x: (anchor.minX + anchor.maxX) / 2,
    y: (anchor.minY + anchor.maxY) / 2,
  };
}

/**
 * How deep to push, from how localized the cluster is.
 *
 * The zoom that would just contain the cluster's box plus `CLUSTER_PADDING`,
 * clamped into the strength's range. A single click has a zero-size box and takes
 * the range's maximum; a cluster spanning half the screen takes something near
 * the minimum. That one rule is what reproduces the observed behaviour that the
 * zoom amount tracks how localized the action is, with nothing else to keep in
 * agreement with it.
 */
export function depthFor(
  anchor: Anchor,
  frame: Size,
  strength: ZoomStrength,
): number {
  const range = zoomRangeFor(strength);
  if (range.max <= 1) {
    return 1;
  }

  const boxWidth = (anchor.maxX - anchor.minX) / frame.width;
  const boxHeight = (anchor.maxY - anchor.minY) / frame.height;
  const extent = Math.max(boxWidth, boxHeight) * (1 + CLUSTER_PADDING);

  // `extent` is the fraction of the frame the cluster wants to fill, so the zoom
  // that fills it is its reciprocal. A zero extent means a point, which wants as
  // much as it is allowed.
  const wanted = extent <= 0 ? range.max : 1 / extent;

  return Math.min(range.max, Math.max(range.min, wanted));
}

/**
 * Turn the input track into moves, then make the moves legal.
 *
 * "Legal" is three rules, and the order matters because each can create work for
 * the next:
 *
 *  1. Anchors close in time *and* place are one cluster, so two looks at the same
 *     control are one held move rather than a zoom out and straight back in.
 *  2. **Two clusters that cannot both have their own move become one move**, by
 *     `packSegments` below. This is what replaced dropping the later one.
 *  3. No more than `MAX_ZOOMED_FRACTION` of the take is zoomed, **dwells only**;
 *     a cluster with a click in it is never dropped.
 *
 * Then the tail is released so the clip finishes on the whole screen.
 *
 * The result is sorted and non-overlapping, which is what `sampleZoom` assumes.
 */
export function planZoom(
  input: { cursor: readonly CursorSample[]; pointer: readonly PointerMark[] },
  frame: Size,
  strength: ZoomStrength,
  durationMs: number,
): ZoomSegment[] {
  if (zoomRangeFor(strength).max <= 1) {
    return [];
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return [];
  }
  if (frame.width <= 0 || frame.height <= 0) {
    return [];
  }

  const clusters = cluster(findAnchors(input.cursor, input.pointer, frame), frame);
  const packed = packSegments(clusters, frame, strength, durationMs);

  return releaseAtEnd(capZoomedTime(packed, durationMs), durationMs);
}

/** A segment and the cluster it came from, so the later rules can see the clicks. */
type Packed = ZoomSegment & { weight: number; clicks: number };

/**
 * Lay the clusters out as non-overlapping moves, merging any two that will not
 * both fit.
 *
 * The rule that decides "will not fit" is the module's own premise: **a zoom has
 * to begin before the thing it is zooming at.** If the previous move's ease-out
 * has not finished by the time this cluster's lookahead should have started, the
 * zoom would arrive after the click and the viewer would see the move, then the
 * camera chasing it.
 *
 * The old answer was to drop the later cluster, which is where clicks went
 * missing: fourteen presses in a real 37-second take produced eight moves and six
 * presses that did nothing at all. Merging instead keeps every one. The merged
 * cluster's box is the union of both, so `depthFor` answers a shallower zoom
 * framed to hold both places, which is also the only non-nauseating way to cover
 * two points at once: a wide framing rather than a pan across the screen at full
 * zoom.
 *
 * Restarting after each merge rather than fixing up in place: a merge moves the
 * cluster's start earlier and its end later, so it can conflict with the
 * neighbour *before* it as well, and the loop is over tens of clusters.
 */
function packSegments(
  clusters: readonly Anchor[],
  frame: Size,
  strength: ZoomStrength,
  durationMs: number,
): Packed[] {
  let work = clusters.slice();

  // Bounded by construction: every pass either finishes or removes one cluster.
  for (let guard = 0; guard <= clusters.length; guard += 1) {
    const built: Packed[] = [];
    let earliest = 0;
    let conflict = -1;

    for (let index = 0; index < work.length; index += 1) {
      const anchor = work[index];
      const wanted = Math.max(0, anchor.start - LOOKAHEAD_MS);
      let inStart = Math.max(wanted, earliest);

      // The move before it runs so late that this one cannot begin before its own
      // activity. Three answers, in order of how little they give up.
      if (index > 0 && inStart > anchor.start - MIN_LEAD_MS) {
        const previous = built[built.length - 1];
        const release = previous == null ? null : shortened(previous, wanted);

        if (release != null) {
          // Cheapest: the move in front gives up some of its hold.
          built[built.length - 1] = release;
          inStart = Math.max(wanted, release.outEnd);
        } else if (anchor.end - work[index - 1].start <= MAX_CLUSTER_MS) {
          // The two are one piece of activity. One wider framing covers both, and
          // it is the only non-nauseating way to hold two places at once.
          conflict = index;
          break;
        }
        // Otherwise: start late. A zoom arriving just after its click is worth
        // having; merging a run this long would frame so wide it shows most of
        // the screen, which is not a zoom at all.
      }

      const inEnd = inStart + EASE_IN_MS;

      // Clamped so the release still fits inside the take. Activity that runs to
      // the very last frame would otherwise want to hold past the end, and the
      // move was then dropped for being unfinishable: measured on a real take,
      // that is how a click at 14.4s of an 18.5s recording got no zoom at all, by
      // being clustered into a dwell that ran to the end.
      const wantedOut = Math.max(inEnd + MIN_HOLD_MS, anchor.end + HOLD_AFTER_MS);
      const outStart = Math.max(inEnd, Math.min(wantedOut, durationMs - EASE_OUT_MS));
      const outEnd = Math.min(durationMs, outStart + EASE_OUT_MS);

      if (outStart - inEnd < SHORT_HOLD_MS) {
        // Not enough of the take left to arrive, sit still for a moment and
        // release. A move without that reads as a flinch rather than as emphasis,
        // and this is the one case where nothing is the better answer, click or
        // no click: a press in the last half second of a recording has nothing
        // left to be emphasised over.
        continue;
      }

      const centre = centreOf(anchor);
      built.push({
        inStart,
        inEnd,
        outStart,
        outEnd,
        zoom: depthFor(anchor, frame, strength),
        u: centre.x / frame.width,
        v: centre.y / frame.height,
        weight: anchor.weight,
        clicks: anchor.clicks,
      });
      earliest = outEnd;
    }

    if (conflict < 0) {
      return built;
    }

    work = merged(work, conflict);
  }

  return [];
}

/**
 * The same move with its release pulled back to `by`, or `null` if it cannot be.
 *
 * `null` rather than a best effort: the caller has two other answers and needs to
 * know this one did not work, not to be handed a move too short to read.
 */
function shortened(segment: Packed, by: number): Packed | null {
  const outEnd = by;
  const outStart = outEnd - EASE_OUT_MS;

  if (outStart < segment.inEnd + SHORT_HOLD_MS) {
    return null;
  }
  if (outEnd >= segment.outEnd) {
    return segment;
  }

  return { ...segment, outStart, outEnd };
}

/** Fold `index` into the cluster before it, box, weight, clicks and all. */
function merged(work: readonly Anchor[], index: number): Anchor[] {
  const previous = work[index - 1];
  const anchor = work[index];

  const fused: Anchor = {
    start: Math.min(previous.start, anchor.start),
    end: Math.max(previous.end, anchor.end),
    minX: Math.min(previous.minX, anchor.minX),
    maxX: Math.max(previous.maxX, anchor.maxX),
    minY: Math.min(previous.minY, anchor.minY),
    maxY: Math.max(previous.maxY, anchor.maxY),
    weight: previous.weight + anchor.weight,
    clicks: previous.clicks + anchor.clicks,
  };

  return [...work.slice(0, index - 1), fused, ...work.slice(index + 1)];
}

/**
 * Drop the weakest *dwells* until the take is mostly not zoomed.
 *
 * A clip zoomed throughout is not an effect, it is a static crop with extra steps
 * and the viewer loses the sense of where on the screen anything is. But the cap
 * only ever spends dwells: a cluster with a click in it stays, however much of
 * the take is already spoken for, because the user pressed there and a plan that
 * answers nothing to a press is the plan being wrong.
 */
function capZoomedTime(
  segments: readonly Packed[],
  durationMs: number,
): ZoomSegment[] {
  const budget = durationMs * MAX_ZOOMED_FRACTION;
  const span = (segment: ZoomSegment) => segment.outEnd - segment.inStart;

  let total = segments.reduce((sum, segment) => sum + span(segment), 0);
  if (total <= budget) {
    return segments.map(strip);
  }

  const droppable = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment.clicks === 0)
    .sort(
      (a, b) =>
        a.segment.weight - b.segment.weight || span(a.segment) - span(b.segment),
    );

  const dropped = new Set<number>();
  for (const { segment, index } of droppable) {
    if (total <= budget) {
      break;
    }
    // Never the last one. On a short take a single long look can exceed the
    // budget on its own, and dropping it would answer "no zoom at all" to a
    // recording of somebody doing exactly one thing, which is the case the
    // feature is most obviously for.
    if (dropped.size >= segments.length - 1) {
      break;
    }
    dropped.add(index);
    total -= span(segment);
  }

  return segments.filter((_, index) => !dropped.has(index)).map(strip);
}

function strip(segment: Packed): ZoomSegment {
  const { weight, clicks, ...rest } = segment;
  return rest;
}

/**
 * How long before the end the last zoom must be finished.
 *
 * A clip that ends mid-zoom leaves the viewer looking at a fragment of a screen
 * with no idea where it was. Releasing first re-establishes the whole picture,
 * which is also the frame the next clip is cut against.
 */
const RELEASE_BEFORE_END_MS = 400;

function releaseAtEnd(
  segments: readonly ZoomSegment[],
  durationMs: number,
): ZoomSegment[] {
  const deadline = durationMs - RELEASE_BEFORE_END_MS;
  const result: ZoomSegment[] = [];

  for (const segment of segments) {
    if (segment.outEnd <= deadline) {
      result.push(segment);
      continue;
    }

    // Pull the release earlier rather than dropping the move. The hold is what
    // gives, down to `SHORT_HOLD_MS`: a click late in a take still gets its zoom,
    // it just does not get to sit there long.
    const outEnd = Math.max(segment.inEnd, deadline);
    const outStart = Math.max(segment.inEnd, outEnd - EASE_OUT_MS);

    if (outStart - segment.inEnd < SHORT_HOLD_MS) {
      continue;
    }

    result.push({ ...segment, outStart, outEnd });
  }

  return result;
}

/**
 * The view at one instant.
 *
 * Zoom and aim move together on the same eased parameter, so a zoom is one
 * gesture rather than a pan and a push that happen to overlap. Outside every
 * segment the answer is `RESTING_VIEW`, which is what makes an empty plan and a
 * disabled auto-zoom the same code path.
 *
 * `progress` is handed back rather than resolved here because this module does
 * not know the resting pose: under a contained fit the clip rests *smaller* than
 * the frame, and how much smaller is `recordFit.ts`'s answer. The caller blends.
 */
export function sampleZoom(
  segments: readonly ZoomSegment[],
  tMs: number,
): ZoomView {
  if (!Number.isFinite(tMs)) {
    return RESTING_VIEW;
  }

  const segment = segments.find(
    (candidate) => tMs >= candidate.inStart && tMs < candidate.outEnd,
  );

  if (segment == null) {
    return RESTING_VIEW;
  }

  let progress: number;

  if (tMs < segment.inEnd) {
    const span = segment.inEnd - segment.inStart;
    progress = span > 0 ? smoothstep((tMs - segment.inStart) / span) : 1;
  } else if (tMs < segment.outStart) {
    progress = 1;
  } else {
    const span = segment.outEnd - segment.outStart;
    progress = span > 0 ? 1 - smoothstep((tMs - segment.outStart) / span) : 0;
  }

  return { progress, zoom: segment.zoom, u: segment.u, v: segment.v };
}

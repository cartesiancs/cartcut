import type { Timeline } from "../../@types/timeline";
import { isVisualTimelineElement } from "../../@types/timeline";
import { isElementVisibleAtTime } from "../element/time";
import { frameToMs, msToFrameCeil } from "../timeline/frames";

/**
 * How much work each frame of an export costs, relative to the others.
 *
 * The old ETA assumed every frame cost the same, which is the largest single
 * source of its error. Measured through the e2e harness on a 1080p60 project,
 * the time to advance one percent ranged from 6.7s to 47.2s: a busy stretch of
 * timeline costs several times what a sparse one does, and an estimator that
 * cannot see that is guessing about most of what remains.
 *
 * The units are arbitrary. Only the *relative* shape matters, because `eta.ts`
 * measures milliseconds-per-work-unit at runtime and that measurement divides
 * out any constant factor. This is what makes the weights below safe to be
 * approximate: get the ratios roughly right and the estimate improves; make
 * them all equal and the model degrades into exactly the frame counting it
 * replaces. Every failure path here returns that uniform curve rather than
 * throwing, so the worst case is the behaviour this file was written to fix,
 * never something worse.
 */
export type CostCurve = {
  /** Predicted work of the whole export. */
  total: number;
  /**
   * Predicted work of frames `[0, frameIndex)` — what has been paid for once
   * `frameIndex` frames are done.
   *
   * The frame loop only ever moves forward, so this walks a cursor rather than
   * searching. A backwards call is still answered correctly, just from the
   * start.
   */
  before(frameIndex: number): number;
};

/**
 * The parts of a frame that happen whatever is on screen: the canvas clear, the
 * `getImageData` readback, and the handover to the pipe. `renderTimeline.ts`
 * measures the readback at ~3.6ms at 1080p and it does not vary with content,
 * so every frame is worth at least this much.
 */
const FRAME_BASE = 1;

/**
 * The first visible video on a frame.
 *
 * Video dominates because it is the only element the loop *awaits*: it blocks
 * on a real `seeked` event before compositing, and a seek into a long-GOP
 * region costs a keyframe decode plus the frames between it and the target.
 * Everything else is a synchronous draw.
 */
const VIDEO_FIRST = 6;

/**
 * Each additional visible video, which costs far less than the first.
 *
 * `loadedAssetStore.seek` issues every seek under one `Promise.all`, so a frame
 * showing four videos waits roughly as long as its slowest seek, not four times
 * as long. Charging `VIDEO_FIRST` per clip would make a picture-in-picture
 * stretch look several times more expensive than it is and skew the whole
 * curve toward it.
 */
const VIDEO_EXTRA = 2;

/**
 * Extra for a video with filters on. The WebGL pipeline runs one pass per
 * filter, and the export path sets `waitFilter`, so it also pays a blocking
 * `gl.finish()` that the preview does not.
 */
const VIDEO_FILTERED = 2;

/** Synchronous draws, priced against `FRAME_BASE`. */
const VISIBLE_COST: Record<string, number> = {
  gif: 2,
  image: 1,
  text: 0.35,
  shape: 0.3,
};

/** Fallback for a filetype added later without a weight of its own. */
const VISIBLE_COST_DEFAULT = 0.5;

/**
 * The full-resolution scratch canvas an effect forces, plus the blit back.
 *
 * Charged **once per frame** however many effects are active: `planFrame` sets
 * one `needsScratch` for the frame, and `renderTimelineAtTime` allocates one
 * scratch buffer regardless of how many effects read it.
 */
const EFFECT_SCRATCH = 3;

/** Each effect's own shader or overlay pass, on top of the shared scratch. */
const EFFECT_PASS = 1;

/**
 * A transition: both clips drawn into separate buffers through `drawOne`, then
 * mixed by a shader.
 */
const TRANSITION_COST = 3;

/**
 * Above this many elements the per-segment sweep is not worth its own cost.
 *
 * The sweep is O(segments x elements), and segments grow with elements too — so
 * this is quadratic. At 116 elements it is ~27k predicate calls and runs in
 * single-digit milliseconds; at 5,000 it would be tens of millions, on the
 * click that starts an export. Degrading to the uniform curve is free, which is
 * the whole point of the design.
 */
const MAX_ELEMENTS_FOR_SWEEP = 500;

/** A curve that says every frame costs the same. The graceful-degradation path. */
function uniformCurve(totalFrames: number): CostCurve {
  const total = Number.isFinite(totalFrames) ? Math.max(0, totalFrames) : 0;
  return {
    total,
    before: (frameIndex: number) => clampIndex(frameIndex, total),
  };
}

function clampIndex(frameIndex: number, totalFrames: number): number {
  if (!Number.isFinite(frameIndex) || frameIndex <= 0) {
    return 0;
  }
  return Math.min(frameIndex, totalFrames);
}

/**
 * The weight of the frame rendered at `timeInMs`.
 *
 * Deliberately asks the *same* questions the frame loop asks —
 * `isVisualTimelineElement` and `isElementVisibleAtTime` — rather than
 * re-deriving visibility from `startTime` and `duration`. A model that
 * disagreed with the compositor about what is on screen would predict the wrong
 * shape, and `isElementVisibleAtTime` is also where the transition widening
 * lives: inside a transition's window a clip is on screen past its own
 * out-point, and only that function knows it.
 */
function weightAt(timeline: Timeline, timeInMs: number): number {
  let weight = FRAME_BASE;
  let videos = 0;
  let effects = 0;

  for (const element of Object.values(timeline)) {
    if (element.filetype === "transition") {
      if (isInOwnSpan(element.startTime, element.duration, timeInMs)) {
        weight += TRANSITION_COST;
      }
      continue;
    }

    if (element.filetype === "effect") {
      if (isInOwnSpan(element.startTime, element.duration, timeInMs)) {
        effects++;
      }
      continue;
    }

    // Audio has no picture and a group paints nothing; both are excluded here,
    // by the same guard the paint loop uses.
    if (!isVisualTimelineElement(element)) {
      continue;
    }
    if (!isElementVisibleAtTime(timeInMs, timeline, element)) {
      continue;
    }

    if (element.filetype === "video") {
      videos++;
      weight += videos === 1 ? VIDEO_FIRST : VIDEO_EXTRA;
      if (element.filter?.enable === true && element.filter.list.length > 0) {
        weight += VIDEO_FILTERED;
      }
      continue;
    }

    weight += VISIBLE_COST[element.filetype] ?? VISIBLE_COST_DEFAULT;
  }

  if (effects > 0) {
    weight += EFFECT_SCRATCH + EFFECT_PASS * effects;
  }

  return weight;
}

/**
 * Whether `timeInMs` falls in an element's own `[start, start + duration)`.
 *
 * Effects and transitions are whole-frame operations rather than elements that
 * paint themselves, so `isElementVisibleAtTime` — which takes a
 * `VisualTimelineElement` — does not apply to them. Their own span is the whole
 * of their window; see `transitionGeometry.ts#windowOf`, which is this
 * expression.
 */
function isInOwnSpan(
  startTime: number,
  duration: number,
  timeInMs: number,
): boolean {
  return timeInMs >= startTime && timeInMs < startTime + duration;
}

/**
 * Build the cost curve for one export.
 *
 * Evaluated per *segment*, not per frame. Visibility only changes where an
 * element's span begins or ends, so the whole document is described by at most
 * `2N + 2` boundaries however many frames the export has: an 18,000-frame
 * project with 116 elements costs ~234 weight evaluations rather than two
 * million.
 *
 * Both edges of a span are taken with `msToFrameCeil`, because a frame shows a
 * clip exactly when `frameToMs(f)` falls in the half-open `[start, end)` that
 * `isTimeInRange` tests — so the first frame that shows it is `ceil(start)` and
 * the first that does not is `ceil(end)`. Flooring the start would charge for a
 * frame rendered before the clip appears.
 *
 * Returns a uniform curve for a degenerate document, an oversized one, or any
 * arithmetic that does not come out finite and positive.
 */
export function buildCostCurve(
  timeline: Timeline,
  totalFrames: number,
  fps: number,
): CostCurve {
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) {
    return uniformCurve(0);
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    return uniformCurve(totalFrames);
  }

  const elements = Object.values(timeline);
  if (elements.length === 0 || elements.length > MAX_ELEMENTS_FOR_SWEEP) {
    return uniformCurve(totalFrames);
  }

  const boundaries = new Set<number>([0, totalFrames]);
  for (const element of elements) {
    const start = element.startTime;
    const end = start + element.duration;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      continue;
    }
    addBoundary(boundaries, msToFrameCeil(start, fps), totalFrames);
    addBoundary(boundaries, msToFrameCeil(end, fps), totalFrames);
  }

  const edges = [...boundaries].sort((a, b) => a - b);
  const segments = edges.length - 1;

  // Cumulative work at each edge, so `before` is a lookup and one
  // multiplication rather than a sum over segments.
  const cumulative: number[] = new Array(edges.length);
  const perFrame: number[] = new Array(segments);
  let running = 0;

  for (let i = 0; i < segments; i++) {
    cumulative[i] = running;
    const from = edges[i];
    // Sampled at the segment's first frame, at exactly the instant the frame
    // loop samples it — `frameTimeMs` is `frameToMs`, and the boundaries above
    // are the frames where visibility flips, so the weight is constant across
    // the segment and this is a member of it.
    const weight = weightAt(timeline, frameToMs(from, fps));
    perFrame[i] = Number.isFinite(weight) && weight > 0 ? weight : FRAME_BASE;
    running += perFrame[i] * (edges[i + 1] - from);
  }
  cumulative[edges.length - 1] = running;

  if (!Number.isFinite(running) || running <= 0) {
    return uniformCurve(totalFrames);
  }

  let cursor = 0;

  return {
    total: running,
    before(frameIndex: number): number {
      const index = clampIndex(frameIndex, totalFrames);
      if (index <= 0) {
        cursor = 0;
        return 0;
      }
      if (index >= totalFrames) {
        return running;
      }
      if (edges[cursor] > index) {
        cursor = 0;
      }
      while (cursor + 1 < segments && edges[cursor + 1] <= index) {
        cursor++;
      }
      return cumulative[cursor] + perFrame[cursor] * (index - edges[cursor]);
    },
  };
}

function addBoundary(
  into: Set<number>,
  frame: number,
  totalFrames: number,
): void {
  if (!Number.isFinite(frame) || frame <= 0 || frame >= totalFrames) {
    return;
  }
  into.add(frame);
}

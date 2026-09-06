/**
 * The point tracker.
 *
 * Pyramidal Lucas–Kanade for the motion estimate, normalised cross-correlation
 * against the frame the user seeded on for the verdict. That pairing is what
 * After Effects, Premiere and Resolve all ship as their point tracker, and each
 * half covers the other's failure:
 *
 * - **LK alone drifts.** It matches consecutive frames, so every frame's small
 *   error is added to the last one's and never subtracted. Over a few hundred
 *   frames the point walks off the feature while reporting a perfect
 *   frame-to-frame fit the whole way.
 * - **NCC alone cannot find anything far away.** It is an exhaustive search, so
 *   its reach is its cost squared; a radius wide enough for a fast pan is a
 *   search nobody waits for.
 *
 * So LK predicts — cheaply, and over large motion, because the pyramid lets the
 * coarsest level see a 32-pixel jump as a 2-pixel one — and NCC then checks that
 * prediction against the *original* patch and corrects it within a small radius.
 * The correction is what removes the drift, because the reference never moves.
 *
 * The whole module is DOM-free and works on `GrayImage`, so `tracker.test.ts`
 * can drive it with synthetic sequences whose true displacement is known to the
 * hundredth of a pixel. That is the only honest way to measure a tracker: on
 * real footage there is nothing to compare the answer to.
 *
 * ## Why this is a fold rather than an object
 *
 * `stepTracker(state, frame)` returns the next state. The panel folds it as
 * frames arrive from `frameSource.ts` so it can draw the path live; the suite
 * folds the same function over an array. There is one implementation, and the
 * state is inspectable at every frame rather than hidden in a class.
 *
 * A step that cannot proceed — the run already finished, or the frame is the
 * wrong size — returns **its input, by identity**. That is the same convention
 * the document ops use, and it is what lets the panel's loop say
 * `if (next === state) break;` without a second status check.
 */

import {
  buildPyramid,
  pyramidLevelsFor,
  sampleBilinear,
  type GrayImage,
} from "./gray";

export type TrackPoint = { x: number; y: number };

/** One frame handed to the tracker, in **source** milliseconds. */
export type TrackFrame = {
  sourceMs: number;
  image: GrayImage;
};

export type TrackSample = {
  sourceMs: number;
  /** Position in the working image's pixels — see `frameSource.ts#toSourcePixels`. */
  x: number;
  y: number;
  /** NCC against the seed patch, −1..1. */
  confidence: number;
};

export type TrackOptions = {
  /** Half-width of the correlation window. The patch is `(2r+1)²`. */
  windowRadius: number;
  /** How far NCC looks around LK's prediction, in pixels. */
  searchRadius: number;
  /** Levels in the pyramid, including the original. 0 means "choose for me". */
  pyramidLevels: number;
  lkIterations: number;
  /** Stop iterating once a step moves less than this, in pixels. */
  lkEpsilon: number;
  /**
   * Texture gate: the smaller eigenvalue of the LK gradient matrix, per pixel.
   *
   * Zero on a flat wall and on a straight edge alike — an edge constrains
   * motion across itself and not along it, which is the aperture problem, and a
   * tracker that accepts one slides along it happily and confidently.
   */
  minEigenvalue: number;
  /** Below this NCC a frame does not count as a match. */
  confidenceThreshold: number;
  /** How many consecutive unmatched frames end the run. */
  lostFrameTolerance: number;
  /**
   * Blend the reference patch towards what is actually being seen.
   *
   * Off by default, and that default is the important part: adapting handles
   * rotation and lighting change, and it re-admits exactly the drift the fixed
   * reference exists to remove, because the thing each frame is checked against
   * is now a thing the previous frames wrote. It is a deliberate trade for a
   * shot that cannot be tracked otherwise, not a better setting.
   */
  adaptTemplate: boolean;
  /** How much of the current patch is mixed in per frame when adapting. */
  adaptRate: number;
};

export const DEFAULT_TRACK_OPTIONS: TrackOptions = {
  windowRadius: 12,
  searchRadius: 10,
  pyramidLevels: 0,
  lkIterations: 20,
  lkEpsilon: 0.01,
  minEigenvalue: 0.5,
  confidenceThreshold: 0.55,
  lostFrameTolerance: 3,
  adaptTemplate: false,
  adaptRate: 0.1,
};

export type TrackStatus =
  | "tracking"
  /** Ran to the last frame it was given. */
  | "completed"
  /** Stopped believing itself. `lostAtMs` says where. */
  | "lost"
  /** The seed had nothing to lock onto. No samples at all. */
  | "no-texture";

/** The reference patch, with the two statistics NCC needs precomputed. */
type Patch = {
  data: Float32Array;
  radius: number;
  mean: number;
  /** `sqrt(Σ (v − mean)²)`. Zero means a flat patch, which NCC cannot score. */
  norm: number;
};

export type TrackerState = {
  readonly options: TrackOptions;
  readonly template: Patch;
  /** The frame the next step compares against. */
  readonly pyramid: readonly GrayImage[];
  readonly point: TrackPoint;
  readonly samples: readonly TrackSample[];
  readonly status: TrackStatus;
  readonly lostAtMs: number | null;
  readonly lowStreak: number;
};

export function resolveTrackOptions(
  partial: Partial<TrackOptions> | undefined,
): TrackOptions {
  return { ...DEFAULT_TRACK_OPTIONS, ...(partial ?? {}) };
}

/**
 * Seed the tracker on the frame the user clicked.
 *
 * The seed frame is itself the first sample, at confidence 1: it *is* the
 * reference, so it matches itself exactly, and emitting it means the resulting
 * keyframe track starts where the user pointed rather than one frame later.
 */
export function startTracker(
  frame: TrackFrame,
  seed: TrackPoint,
  partial?: Partial<TrackOptions>,
): TrackerState {
  const options = resolveTrackOptions(partial);
  const template = extractPatch(frame.image, seed.x, seed.y, options.windowRadius);

  const base: Omit<TrackerState, "status" | "samples"> = {
    options,
    template,
    pyramid: buildPyramid(frame.image, levelsFor(frame.image, options)),
    point: { x: seed.x, y: seed.y },
    lostAtMs: null,
    lowStreak: 0,
  };

  // A flat patch has no norm, so every NCC against it is 0/0. Refusing here
  // rather than at the first step means the panel can say "there is nothing to
  // track here" while the user still has the box under the cursor, instead of
  // running a progress bar to the end of the clip to say the same thing.
  if (template.norm <= 0) {
    return { ...base, status: "no-texture", samples: [] };
  }

  return {
    ...base,
    status: "tracking",
    samples: [{ sourceMs: frame.sourceMs, x: seed.x, y: seed.y, confidence: 1 }],
  };
}

/**
 * One frame on.
 *
 * Returns the state by identity when there is nothing to do — the run is over,
 * or the frame does not match the size the pyramid was built at. The second is
 * not defensive noise: `frameSource.ts` scales every frame to one working size,
 * and a mismatch means something upstream changed source mid-run, which must
 * stop the fold rather than silently track a different picture.
 */
export function stepTracker(
  state: TrackerState,
  frame: TrackFrame,
): TrackerState {
  if (state.status !== "tracking") {
    return state;
  }
  const previous = state.pyramid[0];
  if (
    frame.image.width !== previous.width ||
    frame.image.height !== previous.height
  ) {
    return state;
  }

  const nextPyramid = buildPyramid(
    frame.image,
    levelsFor(frame.image, state.options),
  );

  const predicted = predictByLk(
    state.pyramid,
    nextPyramid,
    state.point,
    state.options,
  );

  // Two candidates, scored by the same measure: where LK says the feature went,
  // and the best NCC match near there. Taking the better of the two is what
  // lets a frame LK failed on — an occlusion, a hard cut in the middle of a
  // clip — still be recovered by the search, and what lets the search be small
  // enough to be free when LK is working.
  const searched = searchNcc(
    nextPyramid[0],
    state.template,
    predicted,
    state.options.searchRadius,
  );
  const direct = nccAtSubpixel(nextPyramid[0], state.template, predicted);

  const point = searched.score >= direct ? searched.point : predicted;
  const confidence = Math.max(searched.score, direct);

  const matched = confidence >= state.options.confidenceThreshold;
  const lowStreak = matched ? 0 : state.lowStreak + 1;

  if (lowStreak >= state.options.lostFrameTolerance) {
    // Stop, and say where. Carrying on past a lost feature is worse than
    // failing: it writes keyframes that look authored onto whatever the search
    // latched onto next, and the user has no way to see which ones are real.
    // The samples up to the last one it *believed* are kept — a partial track
    // the user can extend is worth more than nothing.
    //
    // The trailing unmatched samples are dropped rather than kept, and this is
    // the whole reason a tolerance exists at all. The tolerance is there to
    // ride out a frame or two of noise without ending the run; it is not a
    // statement that those frames were tracked. `state.lowStreak` is exactly
    // how many of them are already in the list — the current frame is not
    // appended on this branch — and keeping them would put `lostFrameTolerance
    // − 1` keyframes on whatever the search drifted onto while the feature was
    // behind something, right at the end of the track where they are least
    // likely to be noticed and most likely to be trusted.
    //
    // The seed always survives: it is the user's own click, not a measurement.
    const kept = state.samples.slice(
      0,
      Math.max(1, state.samples.length - state.lowStreak),
    );

    return {
      ...state,
      status: "lost",
      samples: kept,
      lostAtMs: kept[kept.length - 1]?.sourceMs ?? null,
      lowStreak,
    };
  }

  return {
    ...state,
    template:
      state.options.adaptTemplate && matched
        ? adaptPatch(
            state.template,
            nextPyramid[0],
            point,
            state.options.adaptRate,
          )
        : state.template,
    pyramid: nextPyramid,
    point,
    samples: [
      ...state.samples,
      { sourceMs: frame.sourceMs, x: point.x, y: point.y, confidence },
    ],
    lowStreak,
  };
}

/** Mark a run that reached the end of its frames. */
export function finishTracker(state: TrackerState): TrackerState {
  return state.status === "tracking" ? { ...state, status: "completed" } : state;
}

/** Fold `stepTracker` over a whole sequence. The suite's entry point. */
export function trackSequence(
  frames: readonly TrackFrame[],
  seed: TrackPoint,
  options?: Partial<TrackOptions>,
): TrackerState {
  if (frames.length === 0) {
    // Nothing to seed from, so there is no reference patch to build and no
    // sensible state to return but a refusal.
    return startTracker(
      { sourceMs: 0, image: { data: new Float32Array(0), width: 0, height: 0 } },
      seed,
      options,
    );
  }

  let state = startTracker(frames[0], seed, options);
  for (let i = 1; i < frames.length; i++) {
    const next = stepTracker(state, frames[i]);
    if (next === state) {
      break;
    }
    state = next;
  }
  return finishTracker(state);
}

// ------------------------------------------------------------------ internals

function levelsFor(image: GrayImage, options: TrackOptions): number {
  if (options.pyramidLevels > 0) {
    return options.pyramidLevels;
  }
  return pyramidLevelsFor(image.width, image.height);
}

/**
 * Pyramidal Lucas–Kanade, coarse to fine.
 *
 * The displacement found at a level is doubled on the way down, so each finer
 * level starts from an estimate that is already within a pixel or two and only
 * has to refine it. That is the entire reason for the pyramid: LK's linearised
 * solve is valid over about a window's worth of motion, and halving the picture
 * halves the motion with it.
 *
 * A level that fails its texture gate is skipped rather than fatal — the
 * coarsest levels of a small feature are often flat, and the fine levels are
 * where the answer is anyway. Only the returned point matters; whether LK
 * believed itself is not consulted, because NCC scores the result regardless.
 */
function predictByLk(
  previous: readonly GrayImage[],
  next: readonly GrayImage[],
  point: TrackPoint,
  options: TrackOptions,
): TrackPoint {
  const levels = Math.min(previous.length, next.length);
  let gx = 0;
  let gy = 0;

  for (let level = levels - 1; level >= 0; level--) {
    const scale = 1 << level;
    const px = point.x / scale;
    const py = point.y / scale;

    const step = lkRefine(
      previous[level],
      next[level],
      px,
      py,
      gx,
      gy,
      options,
    );
    gx = step.dx;
    gy = step.dy;

    if (level > 0) {
      gx *= 2;
      gy *= 2;
    }
  }

  return { x: point.x + gx, y: point.y + gy };
}

/**
 * The iterative solve at one level.
 *
 * `G d = b`, where `G` is the 2×2 sum of outer products of the spatial gradient
 * over the window and `b` is the same gradient weighted by the temporal
 * difference. `G` is built once from the *previous* frame and reused across
 * iterations — it is a property of the patch being tracked, not of the guess —
 * which is what makes each iteration a couple of dot products rather than a
 * fresh solve.
 */
function lkRefine(
  previous: GrayImage,
  next: GrayImage,
  px: number,
  py: number,
  seedDx: number,
  seedDy: number,
  options: TrackOptions,
): { dx: number; dy: number } {
  const r = Math.max(2, Math.round(options.windowRadius));
  const size = 2 * r + 1;
  const count = size * size;

  const template = new Float32Array(count);
  const gradX = new Float32Array(count);
  const gradY = new Float32Array(count);

  let sxx = 0;
  let sxy = 0;
  let syy = 0;

  for (let dy = -r, i = 0; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++, i++) {
      const x = px + dx;
      const y = py + dy;
      template[i] = sampleBilinear(previous, x, y);
      const ix =
        0.5 *
        (sampleBilinear(previous, x + 1, y) - sampleBilinear(previous, x - 1, y));
      const iy =
        0.5 *
        (sampleBilinear(previous, x, y + 1) - sampleBilinear(previous, x, y - 1));
      gradX[i] = ix;
      gradY[i] = iy;
      sxx += ix * ix;
      sxy += ix * iy;
      syy += iy * iy;
    }
  }

  const det = sxx * syy - sxy * sxy;
  const trace = sxx + syy;
  // The smaller root of the 2×2 characteristic polynomial, per pixel so the
  // threshold does not have to be restated for every window size.
  const minEig =
    (trace - Math.sqrt(Math.max(0, trace * trace - 4 * det))) / 2 / count;

  if (det <= 0 || minEig < options.minEigenvalue) {
    return { dx: seedDx, dy: seedDy };
  }

  let dx = seedDx;
  let dy = seedDy;
  // One window of travel is as far as a linearised solve can be trusted; past
  // it the answer is not a refinement of this feature but a jump to whatever
  // else correlated. Bail to the seed rather than return it.
  const maxTravel = size;

  for (let iteration = 0; iteration < options.lkIterations; iteration++) {
    let bx = 0;
    let by = 0;

    for (let wy = -r, i = 0; wy <= r; wy++) {
      for (let wx = -r; wx <= r; wx++, i++) {
        const diff =
          template[i] - sampleBilinear(next, px + wx + dx, py + wy + dy);
        bx += diff * gradX[i];
        by += diff * gradY[i];
      }
    }

    const vx = (syy * bx - sxy * by) / det;
    const vy = (sxx * by - sxy * bx) / det;
    dx += vx;
    dy += vy;

    if (
      Math.abs(dx - seedDx) > maxTravel ||
      Math.abs(dy - seedDy) > maxTravel
    ) {
      return { dx: seedDx, dy: seedDy };
    }
    if (vx * vx + vy * vy < options.lkEpsilon * options.lkEpsilon) {
      break;
    }
  }

  return { dx, dy };
}

/**
 * Exhaustive NCC over integer offsets, then a parabola through the peak.
 *
 * Integer offsets so the patch can be read straight out of the buffer; the
 * sub-pixel part is recovered afterwards from the three scores around the peak,
 * which is exact for a quadratic and good to a few hundredths of a pixel for a
 * correlation surface. Interpolating the *image* instead would cost `(2R+1)²`
 * bilinear reads per pixel of the patch for the same answer.
 */
function searchNcc(
  image: GrayImage,
  template: Patch,
  around: TrackPoint,
  radius: number,
): { point: TrackPoint; score: number } {
  const r = Math.max(0, Math.round(radius));
  const cx = Math.round(around.x);
  const cy = Math.round(around.y);
  const span = 2 * r + 1;
  const scores = new Float32Array(span * span);

  let best = -Infinity;
  let bestIx = 0;
  let bestIy = 0;

  for (let oy = -r, iy = 0; oy <= r; oy++, iy++) {
    for (let ox = -r, ix = 0; ox <= r; ox++, ix++) {
      const score = nccAtInteger(image, template, cx + ox, cy + oy);
      scores[iy * span + ix] = score;
      if (score > best) {
        best = score;
        bestIx = ix;
        bestIy = iy;
      }
    }
  }

  const subX = parabolaOffset(
    scores[bestIy * span + Math.max(0, bestIx - 1)],
    best,
    scores[bestIy * span + Math.min(span - 1, bestIx + 1)],
    bestIx > 0 && bestIx < span - 1,
  );
  const subY = parabolaOffset(
    scores[Math.max(0, bestIy - 1) * span + bestIx],
    best,
    scores[Math.min(span - 1, bestIy + 1) * span + bestIx],
    bestIy > 0 && bestIy < span - 1,
  );

  return {
    point: { x: cx + (bestIx - r) + subX, y: cy + (bestIy - r) + subY },
    score: best,
  };
}

/**
 * The vertex of the parabola through three samples, as an offset from the
 * middle one. Clamped to ±0.5: a peak further than half a sample from the
 * sample that scored highest is not a peak, it is a slope, and following it
 * would move the point somewhere no sample supports.
 */
function parabolaOffset(
  left: number,
  centre: number,
  right: number,
  usable: boolean,
): number {
  if (!usable) {
    return 0;
  }
  const denominator = left - 2 * centre + right;
  if (denominator === 0 || !Number.isFinite(denominator)) {
    return 0;
  }
  const offset = (0.5 * (left - right)) / denominator;
  return Math.max(-0.5, Math.min(0.5, offset));
}

function extractPatch(
  image: GrayImage,
  cx: number,
  cy: number,
  radius: number,
): Patch {
  const r = Math.max(2, Math.round(radius));
  const size = 2 * r + 1;
  const data = new Float32Array(size * size);

  for (let dy = -r, i = 0; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++, i++) {
      data[i] = sampleBilinear(image, cx + dx, cy + dy);
    }
  }

  return withStats(data, r);
}

function withStats(data: Float32Array, radius: number): Patch {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
  }
  const mean = data.length === 0 ? 0 : sum / data.length;

  let sq = 0;
  for (let i = 0; i < data.length; i++) {
    const d = data[i] - mean;
    sq += d * d;
  }

  return { data, radius, mean, norm: Math.sqrt(sq) };
}

function adaptPatch(
  template: Patch,
  image: GrayImage,
  at: TrackPoint,
  rate: number,
): Patch {
  const current = extractPatch(image, at.x, at.y, template.radius);
  const mix = Math.max(0, Math.min(1, rate));
  const data = new Float32Array(template.data.length);
  for (let i = 0; i < data.length; i++) {
    data[i] = template.data[i] * (1 - mix) + current.data[i] * mix;
  }
  return withStats(data, template.radius);
}

/**
 * NCC of the template against the patch centred on an integer pixel.
 *
 * Normalised in both senses — mean subtracted and magnitude divided out — so a
 * shot that brightens or a lens that stops down does not read as the feature
 * having changed. That invariance is the reason NCC and not SSD.
 */
function nccAtInteger(
  image: GrayImage,
  template: Patch,
  cx: number,
  cy: number,
): number {
  const r = template.radius;
  const { width, height, data } = image;

  let sum = 0;
  const count = template.data.length;
  const patch = scratchFor(count);

  for (let dy = -r, i = 0; dy <= r; dy++) {
    const y = clampTo(cy + dy, height);
    const row = y * width;
    for (let dx = -r; dx <= r; dx++, i++) {
      const value = data[row + clampTo(cx + dx, width)];
      patch[i] = value;
      sum += value;
    }
  }

  return correlate(template, patch, sum / count);
}

function nccAtSubpixel(
  image: GrayImage,
  template: Patch,
  at: TrackPoint,
): number {
  const r = template.radius;
  const count = template.data.length;
  const patch = scratchFor(count);

  let sum = 0;
  for (let dy = -r, i = 0; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++, i++) {
      const value = sampleBilinear(image, at.x + dx, at.y + dy);
      patch[i] = value;
      sum += value;
    }
  }

  return correlate(template, patch, sum / count);
}

function correlate(
  template: Patch,
  patch: Float32Array,
  patchMean: number,
): number {
  let dot = 0;
  let sq = 0;
  for (let i = 0; i < template.data.length; i++) {
    const b = patch[i] - patchMean;
    dot += (template.data[i] - template.mean) * b;
    sq += b * b;
  }

  const denominator = template.norm * Math.sqrt(sq);
  // A flat patch correlates with nothing, including another flat patch: the
  // question "do these two vary together" has no answer when neither varies.
  // Zero, not one — otherwise a tracker that wanders onto a clear sky reports
  // total confidence.
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * One reusable buffer for the candidate patch.
 *
 * `searchNcc` allocates `(2R+1)²` of these per frame — 441 at the default
 * radius, times the frames in a clip. They are written before they are read, in
 * full, every time, so sharing one is safe and it is the difference between the
 * search allocating nothing and allocating tens of megabytes a second.
 */
let scratch = new Float32Array(0);
function scratchFor(count: number): Float32Array {
  if (scratch.length < count) {
    scratch = new Float32Array(count);
  }
  return scratch;
}

function clampTo(value: number, size: number): number {
  if (value < 0) {
    return 0;
  }
  if (value >= size) {
    return size - 1;
  }
  return value;
}

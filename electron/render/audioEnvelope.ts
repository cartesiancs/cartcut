/**
 * A clip's level envelope, as an FFmpeg `volume` expression.
 *
 * The export's half of the level envelope. The renderer plays a curve by
 * sampling it every animation frame; FFmpeg has no such loop, so the curve has
 * to be handed to it as an expression it evaluates per audio frame.
 *
 * No Electron import and no `apps/app/src` import, so vitest runs it directly.
 * `lib/reverseRecipe.ts` is the precedent: the arithmetic of a render decision
 * lives apart from the process that spawns it.
 *
 * **It reads the baked lane, never the authored keyframes.** `ax` is a flat
 * `[timeMs, value]` array that `keyframeOps.withLane` re-bakes inside the same
 * transform that writes a keyframe, so it is always current, and reading it
 * needs no bezier solver. Reading the authored curve instead would mean
 * hand-copying `keyframes.ts`'s Newton solve into `electron/`, which is the one
 * piece of that file nobody should own twice.
 */

/**
 * A point on the envelope: clip-local timeline ms, and a level in **dB**.
 *
 * dB all the way to the expression, and that is not a formatting preference.
 * The curve was authored over dB values and the baked lane holds dB, so dB is
 * the only domain in which interpolating between two points reproduces the
 * curve the user drew. A first draft carried linear gain here and had the
 * expression interpolate that, which is a different curve entirely: a straight
 * 0 to -40 dB fade came out 3.9 dB loud at its quarter point, and a 0 to +9 dB
 * rise 1.1 dB loud at its middle. `audioEnvelope.parity.test.ts` caught both.
 */
export type EnvelopePoint = { tMs: number; db: number };

/**
 * How far the emitted polyline may sit from the baked curve, in dB.
 *
 * In dB rather than in linear gain because that is the scale the curve was
 * drawn on and the scale an ear hears: 0.1 dB is inaudible anywhere on the
 * fader, while a fixed linear tolerance would be inaudible at the top and
 * enormous near silence.
 */
export const ENVELOPE_TOLERANCE_DB = 0.1;

/**
 * The most line segments one clip's expression may carry.
 *
 * Two separate ceilings meet here, and the lower one wins.
 *
 * FFmpeg's expression parser is recursive, and a flat `a+b+c+…` sum of around
 * 100 terms overflows it: measured against the bundled ffmpeg 9.0, 96 terms
 * evaluate and 100 fail with "Error when evaluating the volume expression",
 * while 512 fails at allocation. `foldSum` below sidesteps that entirely by
 * emitting a balanced tree, which was measured good to 2048 terms, so the
 * parser is no longer the binding constraint.
 *
 * The binding one is the command line. `-filter_complex` travels in argv and
 * Windows caps a command line at 32,767 characters, which several clips each
 * carrying a long expression would reach. 96 segments is about 5.5 KB, and it
 * is far beyond what an authored curve needs: a person places five to thirty
 * keyframes, and one eased segment resolves to four to eight lines inside
 * `ENVELOPE_TOLERANCE_DB`.
 */
export const MAX_ENVELOPE_SEGMENTS = 96;

/** The floor the renderer twin uses, and the level at which a clip is silent. */
const MIN_VOLUME_DB = -60;
/** The ceiling the renderer twin uses. */
const MAX_VOLUME_DB = 12;

/** Twin of `audio.ts#clampVolumeDb`. */
function clampDb(db: number): number {
  if (!Number.isFinite(db)) {
    return 0;
  }
  return Math.min(Math.max(db, MIN_VOLUME_DB), MAX_VOLUME_DB);
}

/**
 * The live level track's baked samples, or `null` if the clip has no envelope.
 *
 * `null` covers "no block", "no track", "switched off" and "no samples" alike,
 * and all four mean the same thing to the caller: play this clip at its static
 * `volumeDb`, which is what `gainOf` already answers. The `isActivate` gate is
 * the one that is easy to miss, and it is the same gate
 * `audio.ts#volumeDbAt` applies: a track the user switched off still holds its
 * curve, and playing it would make the fader appear to do nothing.
 */
export function bakedLevelLane(element: any): number[][] | null {
  const track = element?.animation?.volumeDb;
  if (track == null || track.isActivate !== true) {
    return null;
  }
  const lane = track.ax;
  if (!Array.isArray(lane) || lane.length === 0) {
    return null;
  }
  return lane as number[][];
}

/**
 * Reduce a baked lane to the fewest line segments that stay within `toleranceDb`.
 *
 * Douglas-Peucker, measured in dB against the chord rather than in linear gain,
 * so the error the tolerance bounds is the error anyone could hear. A linear
 * ramp collapses to two points and a hold to two, which is why a 60-second
 * clip's 3,600 baked samples usually come out as a handful.
 *
 * The recursion is written as an explicit stack: a lane can hold
 * `MAX_BAKED_SAMPLES` (36,000) points, and on a pathological curve the
 * recursive form is 36,000 frames deep.
 */
export function simplifyEnvelope(
  points: EnvelopePoint[],
  toleranceDb: number,
): EnvelopePoint[] {
  if (points.length <= 2) {
    return points.slice();
  }

  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) {
      continue;
    }
    const t0 = points[first].tMs;
    const d0 = points[first].db;
    const span = points[last].tMs - t0;
    const rise = points[last].db - d0;

    let worst = -1;
    let worstAt = -1;
    for (let i = first + 1; i < last; i++) {
      // Vertical distance in dB, not perpendicular distance. The two axes here
      // are time and level and have no common unit, so a perpendicular measure
      // would silently depend on the clip's length.
      const onChord =
        span === 0 ? d0 : d0 + (rise * (points[i].tMs - t0)) / span;
      const error = Math.abs(points[i].db - onChord);
      if (error > worst) {
        worst = error;
        worstAt = i;
      }
    }

    if (worst > toleranceDb && worstAt > first) {
      keep[worstAt] = true;
      stack.push([first, worstAt], [worstAt, last]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

/**
 * The envelope for one clip, simplified to fit, or `null` if it has none.
 *
 * The point cap is met by loosening the tolerance rather than by truncating the
 * curve. Truncating would play the first 96 segments and then jump to whatever
 * the last one held, which is a different edit from the one the user made; a
 * coarser fit is the same edit, slightly rounded. The doubling terminates
 * because at a large enough tolerance every curve collapses to its two ends.
 */
export function envelopeFor(element: any): EnvelopePoint[] | null {
  const lane = bakedLevelLane(element);
  if (lane == null) {
    return null;
  }

  const points: EnvelopePoint[] = [];
  for (const sample of lane) {
    if (!Array.isArray(sample) || sample.length < 2) {
      continue;
    }
    const [tMs, db] = sample;
    if (!Number.isFinite(tMs) || !Number.isFinite(db)) {
      continue;
    }
    points.push({ tMs, db: clampDb(db) });
  }
  if (points.length === 0) {
    return null;
  }

  let tolerance = ENVELOPE_TOLERANCE_DB;
  let simplified = simplifyEnvelope(points, tolerance);
  while (simplified.length - 1 > MAX_ENVELOPE_SEGMENTS) {
    tolerance *= 2;
    simplified = simplifyEnvelope(points, tolerance);
  }
  return simplified;
}

/**
 * dB to linear gain. The twin of `apps/app/src/features/timeline/audio.ts`.
 *
 * `ffmpegArgs.test.ts` imports both and asserts they agree exactly, which is
 * what the six-decimal rounding is for. Unity is exact at 0 dB and nowhere
 * else: the test used to be `db >= MAX_VOLUME_DB`, and once the ceiling rose
 * above unity that would have thrown every boost away in silence.
 */
export function gainFromDb(db: number): number {
  if (!Number.isFinite(db) || db <= MIN_VOLUME_DB) {
    return 0;
  }
  if (db === 0) {
    return 1;
  }
  return Number((10 ** (db / 20)).toFixed(6));
}

/** Trim a float for the expression without letting it read as an integer index. */
function num(value: number): string {
  return Number(value.toFixed(6)).toString();
}

/**
 * Fold terms into a balanced `+` tree.
 *
 * **This is the whole reason a long envelope works at all.** FFmpeg parses an
 * expression by recursive descent, so `a+b+c+…` nests as deep as it is long and
 * an envelope of about a hundred terms overflows the parser. A balanced tree is
 * `log2(n)` deep instead, and the same terms that failed flat were measured
 * good to 2048 folded. It costs a few brackets and removes a cliff.
 */
function foldSum(terms: string[]): string {
  if (terms.length === 0) {
    return "0";
  }
  let level = terms;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(
        i + 1 < level.length ? `(${level[i]}+${level[i + 1]})` : level[i],
      );
    }
    level = next;
  }
  return level[0];
}

/**
 * The `volume` expression for an envelope, in clip-local timeline **seconds**.
 *
 * Seconds because that is the unit FFmpeg's `t` carries, and clip-local because
 * the stage sits after `atempo` and before `adelay`: `atempo` rewrites the
 * timestamps, so past it `t` is output time measured from the clip's own start.
 * That makes a baked sample's `tMs / 1000` the breakpoint directly, with no
 * speed term anywhere.
 *
 * **The interpolation happens in dB and is converted at the end**, so each
 * segment contributes `between(t,a,b)*pow(10,(d0+k*(t-a))/20)`. Interpolating
 * the gain instead would be a different curve, and an audibly wrong one: see
 * `EnvelopePoint`.
 *
 * The ranges abut and `between` is inclusive at both ends, so each segment
 * after the first starts one microsecond late. Without that, both terms are
 * live at a shared breakpoint and the sum is twice the level there. A
 * microsecond is a twentieth of a sample at 48 kHz, so the gap cannot contain
 * one.
 *
 * The floor is honoured by **narrowing a segment's range** rather than by
 * clamping inside it. `gainFromDb` is a hard zero at or below -60 dB, not the
 * `0.001` the arithmetic gives, because a fader at the bottom means off; since
 * the level is linear in `t` across a segment, the stretch that is above the
 * floor is itself an interval, and emitting only that leaves the rest summing
 * to zero with no extra term to evaluate.
 *
 * Outside the envelope the first and last levels are held, which is what
 * `sampleBaked` does at both ends too.
 */
export function volumeExprOf(points: EnvelopePoint[]): string {
  if (points.length === 0) {
    return "1";
  }
  if (points.length === 1) {
    return num(gainFromDb(points[0].db));
  }

  const EPS = 1e-6;
  const terms: string[] = [];
  const first = points[0];
  const last = points[points.length - 1];

  // Before the curve starts and after it ends, hold the end values. `lt`/`gt`
  // rather than `between` so no third bound has to be invented for a clip whose
  // duration this module does not know. These are constants, so they convert
  // here rather than in the expression.
  terms.push(`lt(t,${num(first.tMs / 1000)})*${num(gainFromDb(first.db))}`);

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i].tMs / 1000;
    const b = points[i + 1].tMs / 1000;
    const d0 = points[i].db;
    const d1 = points[i + 1].db;
    if (!(b > a)) {
      continue;
    }

    // The window in which this segment is above the floor.
    let from = a;
    let to = b;
    if (d0 <= MIN_VOLUME_DB && d1 <= MIN_VOLUME_DB) {
      continue;
    }
    if (d0 <= MIN_VOLUME_DB || d1 <= MIN_VOLUME_DB) {
      const crossing = a + ((MIN_VOLUME_DB - d0) / (d1 - d0)) * (b - a);
      if (d0 <= MIN_VOLUME_DB) {
        from = crossing;
      } else {
        to = crossing;
      }
    }
    if (!(to > from)) {
      continue;
    }
    if (i > 0 && from === a) {
      from = a + EPS;
    }

    const slope = (d1 - d0) / (b - a);
    terms.push(
      `between(t,${num(from)},${num(to)})*pow(10,(${num(d0)}+${num(slope)}*(t-${num(a)}))/20)`,
    );
  }

  terms.push(`gt(t,${num(last.tMs / 1000)})*${num(gainFromDb(last.db))}`);

  return foldSum(terms);
}

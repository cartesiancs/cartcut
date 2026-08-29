/**
 * The signal processing behind `analyze_audio`, as pure functions.
 *
 * Deliberately free of ffmpeg, Electron and the filesystem, for the same reason
 * `features/timeline/` is free of the DOM: this is where the arithmetic that
 * can be wrong lives, so it has to be the part that is cheap to test. The shell
 * that decodes a file and caches the result is `../analyze.ts`, and it holds no
 * arithmetic of its own.
 *
 * Everything here works on mono PCM in `[-1, 1]`. The caller decodes to that;
 * 16 kHz is plenty, because every feature below is driven by energy rather than
 * by anything living near the top of the spectrum.
 *
 * The onset detector is **energy-based**, not spectral. It differences a
 * loudness envelope and picks peaks, which finds percussive onsets — a kick, a
 * snare, a consonant, a door — well, and melodic onsets that arrive without a
 * change in level poorly. That is the honest trade for not carrying an FFT:
 * the thing an editor actually cuts to is percussive, and a legato string line
 * has no cut point to find. Said plainly here so nobody reads `onsets` as
 * "every note".
 */

/** Quietest level the envelope reports, in dBFS. Silence is not -Infinity. */
export const FLOOR_DB = -100;

export type Envelope = {
  /** Spacing between consecutive entries, in ms. */
  hopMs: number;
  /** Loudness per hop, dBFS, floored at `FLOOR_DB`. */
  db: number[];
};

export type Range = { startMs: number; endMs: number };

export type Tempo = {
  bpm: number;
  /** 0..1. How much better the winning period fit than the average lag. */
  confidence: number;
};

function amplitudeToDb(amplitude: number): number {
  if (!(amplitude > 0)) {
    return FLOOR_DB;
  }
  return Math.max(FLOOR_DB, 20 * Math.log10(amplitude));
}

/**
 * A loudness envelope: RMS per hop, in dBFS.
 *
 * The window is twice the hop so consecutive frames overlap by half. A
 * non-overlapping window makes the envelope jump on transients that happen to
 * straddle a boundary, which then shows up as a spurious onset — cheaper to
 * avoid here than to filter out downstream.
 */
export function rmsEnvelope(
  samples: Float32Array | number[],
  sampleRate: number,
  hopMs = 10,
): Envelope {
  const hop = Math.max(1, Math.round((hopMs * sampleRate) / 1000));
  const window = hop * 2;
  const db: number[] = [];

  for (let start = 0; start < samples.length; start += hop) {
    const end = Math.min(samples.length, start + window);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const s = samples[i];
      sum += s * s;
    }
    const count = end - start;
    db.push(amplitudeToDb(count > 0 ? Math.sqrt(sum / count) : 0));
  }

  return { hopMs, db };
}

/**
 * Stretches quieter than `thresholdDb` lasting at least `minMs`.
 *
 * The agent can already infer gaps between spoken words from the transcript.
 * What it cannot infer is a gap that is not between words — a pause before the
 * take starts, a held breath, a dead room after the last sentence — which is
 * exactly where a cut belongs. Hence an absolute threshold on the signal rather
 * than anything derived from the words.
 */
export function silentRanges(
  envelope: Envelope,
  thresholdDb = -40,
  minMs = 300,
): Range[] {
  const { hopMs, db } = envelope;
  const ranges: Range[] = [];
  let runStart: number | null = null;

  const close = (endIndex: number) => {
    if (runStart == null) {
      return;
    }
    const startMs = runStart * hopMs;
    const endMs = endIndex * hopMs;
    if (endMs - startMs >= minMs) {
      ranges.push({ startMs: Math.round(startMs), endMs: Math.round(endMs) });
    }
    runStart = null;
  };

  for (let i = 0; i < db.length; i++) {
    if (db[i] < thresholdDb) {
      if (runStart == null) {
        runStart = i;
      }
    } else {
      close(i);
    }
  }
  close(db.length);

  return ranges;
}

/**
 * Onset strength: the positive change in loudness, hop by hop.
 *
 * Half-wave rectified because an onset is a rise. A fall is a note ending, and
 * counting it would put a beat at the end of every sound as well as its start.
 *
 * The first hop is differenced against `FLOOR_DB` rather than against itself.
 * A file that begins mid-hit — a clip trimmed hard onto the downbeat, which is
 * the normal case for music — has no rise *inside* the signal, so differencing
 * from the first sample silently loses its first beat. The level before a
 * recording starts is silence, and saying so costs one entry.
 */
export function onsetStrength(envelope: Envelope): number[] {
  const { db } = envelope;
  if (db.length === 0) {
    return [];
  }
  const flux: number[] = [Math.max(0, db[0] - FLOOR_DB)];
  for (let i = 1; i < db.length; i++) {
    flux.push(Math.max(0, db[i] - db[i - 1]));
  }
  return flux;
}

/** Mean of a slice, guarding the empty case. */
function mean(values: number[], from = 0, to = values.length): number {
  const lo = Math.max(0, from);
  const hi = Math.min(values.length, to);
  if (hi <= lo) {
    return 0;
  }
  let sum = 0;
  for (let i = lo; i < hi; i++) {
    sum += values[i];
  }
  return sum / (hi - lo);
}

/**
 * Onset times in ms, by adaptive peak-picking over the strength signal.
 *
 * The threshold is local — a multiple of the mean over a window around each
 * candidate — because a fixed one either misses the quiet half of a track that
 * has a loud half, or fires continuously through the loud half. `minGapMs`
 * then enforces a refractory period, which is what stops one kick drum being
 * reported three times as its envelope wobbles on the way down.
 */
export function detectOnsets(
  envelope: Envelope,
  options: { sensitivity?: number; minGapMs?: number } = {},
): number[] {
  const sensitivity = options.sensitivity ?? 1.5;
  const minGapMs = options.minGapMs ?? 80;

  const flux = onsetStrength(envelope);
  const { hopMs } = envelope;
  const windowHops = Math.max(3, Math.round(500 / hopMs));
  const minGapHops = Math.max(1, Math.round(minGapMs / hopMs));

  const onsets: number[] = [];
  let lastIndex = -Infinity;

  for (let i = 0; i < flux.length; i++) {
    // A peak, not merely a rise. Off the ends the neighbour reads as zero, so
    // a signal that opens on a hit is a peak rather than being skipped.
    const previous = i > 0 ? flux[i - 1] : 0;
    const next = i < flux.length - 1 ? flux[i + 1] : 0;
    if (!(flux[i] > previous && flux[i] >= next)) {
      continue;
    }
    const local = mean(flux, i - windowHops, i + windowHops);
    // The additive term keeps a dead-quiet stretch from producing onsets out of
    // rounding noise, where the local mean is ~0 and any bump beats it.
    if (flux[i] < local * sensitivity + 0.5) {
      continue;
    }
    if (i - lastIndex < minGapHops) {
      continue;
    }
    onsets.push(Math.round(i * hopMs));
    lastIndex = i;
  }

  return onsets;
}

/** Beats per minute as a lag in hops, and back. */
function bpmToLag(bpm: number, hopMs: number): number {
  return (60_000 / bpm) / hopMs;
}

/**
 * How close a faster candidate has to score to win an octave tie.
 *
 * Autocorrelation cannot separate a period from its multiples: a signal that
 * repeats every P also repeats every 2P. Worse, on music with alternating beat
 * strength the double usually scores *higher*, because it lines strong beats up
 * with strong beats instead of pairing strong with weak — so the naive winner
 * is the half-tempo, and reports 66 bpm for a track that is plainly 132.
 *
 * Measured on a real track the double came in at 95.8% of the half. 0.85 takes
 * the fundamental in that case while leaving a genuinely slow piece alone,
 * where the faster lag correlates a beat against silence and scores near zero.
 */
const OCTAVE_TOLERANCE = 0.85;

/**
 * Tempo by autocorrelating the onset strength signal.
 *
 * Autocorrelation over the strength envelope rather than over the discrete
 * onset list: the list has already thrown away how *strong* each onset was, and
 * a beat tracker wants that. The search runs over a musical range only, so a
 * long-period correlation from song structure cannot win.
 *
 * `confidence` is the winning score against the mean score across the range,
 * squashed into 0..1. It is a relative measure on purpose — an absolute one
 * would depend on the recording's level — and speech, which has no pulse,
 * lands low rather than reporting a confident wrong answer.
 */
export function estimateTempo(
  envelope: Envelope,
  options: { minBpm?: number; maxBpm?: number } = {},
): Tempo | null {
  const minBpm = options.minBpm ?? 60;
  const maxBpm = options.maxBpm ?? 200;

  const flux = onsetStrength(envelope);
  const { hopMs } = envelope;

  const minLag = Math.max(2, Math.floor(bpmToLag(maxBpm, hopMs)));
  const maxLag = Math.ceil(bpmToLag(minBpm, hopMs));
  // Two full periods of the slowest tempo, or the answer is a coincidence.
  if (flux.length < maxLag * 2) {
    return null;
  }

  const scores: number[] = [];
  let bestLag = minLag;
  let bestScore = -Infinity;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = lag; i < flux.length; i++) {
      sum += flux[i] * flux[i - lag];
    }
    const score = sum / (flux.length - lag);
    scores.push(score);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  const average = mean(scores);
  if (!(bestScore > 0) || !(average > 0)) {
    return null;
  }

  const scoreAt = (lag: number): number =>
    lag >= minLag && lag <= maxLag ? scores[lag - minLag] : 0;

  /**
   * A peak's energy including its immediate neighbours.
   *
   * A period is almost never a whole number of hops — 128 bpm is 468.75ms
   * against a 10ms grid — so its correlation is *split* between the two lags
   * either side, while a slower period that happens to land closer to a whole
   * hop keeps all of its energy in one bin. Comparing single bins therefore
   * favours whichever period the grid happens to suit, which on a metronome at
   * 128 bpm reports 64. Summing a three-wide window is what makes the
   * comparison about the music rather than about the grid.
   */
  const peakEnergy = (centre: number): number => {
    const lag = Math.round(centre);
    return scoreAt(lag - 1) + scoreAt(lag) + scoreAt(lag + 1);
  };

  /** The best single lag near `centre`, for reporting rather than comparing. */
  const sharpestNear = (centre: number): number => {
    const lag = Math.round(centre);
    let best = lag;
    for (const candidate of [lag - 1, lag, lag + 1]) {
      if (scoreAt(candidate) > scoreAt(best)) {
        best = candidate;
      }
    }
    return best;
  };

  // Walk down to the fundamental. Repeated because a track can win at four
  // times its period, which is two halvings; the shrinking lag reaches
  // `minLag`, where every candidate scores zero, and the loop stops.
  for (;;) {
    let moved = false;
    // Largest speed-up first, so a triplet feel is not read as a duple one.
    for (const divisor of [3, 2]) {
      const centre = bestLag / divisor;
      if (Math.round(centre) < minLag) {
        continue;
      }
      if (peakEnergy(centre) >= peakEnergy(bestLag) * OCTAVE_TOLERANCE) {
        bestLag = sharpestNear(centre);
        bestScore = scoreAt(bestLag);
        moved = true;
        break;
      }
    }
    if (!moved) {
      break;
    }
  }

  const confidence = Math.max(0, Math.min(1, 1 - average / bestScore));

  /**
   * Sub-hop refinement of the winning lag.
   *
   * The grid quantises the period, so the reported rate steps by ~2.7 bpm near
   * 128 — enough that a metronome comes back visibly wrong. Fitting a parabola
   * through the peak and its neighbours recovers the true maximum, which is the
   * standard remedy and costs three multiplications.
   */
  const left = scoreAt(bestLag - 1);
  const right = scoreAt(bestLag + 1);
  const curvature = left - 2 * bestScore + right;
  const shift =
    curvature < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / curvature)) : 0;
  const refinedLag = bestLag + shift;

  return {
    bpm: Math.round((60_000 / (refinedLag * hopMs)) * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
  };
}

/**
 * Beat times, each one anchored to evidence rather than extrapolated.
 *
 * A rate and a starting phase look like enough to generate a grid, and they are
 * not. However carefully the period is estimated it keeps a fraction of a hop
 * of error, and that error **accumulates**: measured here, a 0.3-hop-per-beat
 * discrepancy walked a one-minute click track 370ms off the beat by the end —
 * most of a beat, at which point the grid is worse than useless because it
 * still looks deliberate. A caller handed `bpm` and a downbeat would produce
 * exactly that, and blame the cuts.
 *
 * So each beat is predicted from the last and then **re-anchored to the
 * strongest onset near the prediction**, which is what stops error compounding:
 * every beat is measured, and a wrong one costs one beat rather than every beat
 * after it. Where there is no evidence — a bar of held silence — the prediction
 * stands, so the chain survives a gap without drifting through it.
 *
 * Returns an empty list for a signal with no usable pulse; `estimateTempo`'s
 * `confidence` is the thing to check before trusting any of it.
 */
export function trackBeats(
  envelope: Envelope,
  bpm: number,
  options: { toleranceFraction?: number } = {},
): number[] {
  const { hopMs } = envelope;
  const period = bpmToLag(bpm, hopMs);
  if (!(period > 0) || !Number.isFinite(period)) {
    return [];
  }

  const flux = onsetStrength(envelope);
  if (flux.length === 0) {
    return [];
  }

  // Wide enough to catch a beat played early or late, narrow enough that it
  // cannot reach the neighbouring beat and swap the grid onto the off-beat.
  const tolerance = Math.max(1, Math.round(period * (options.toleranceFraction ?? 0.2)));
  const floor = mean(flux) * 0.5;

  /** The strongest hop in `[from, to]`, or null if nothing beats the floor. */
  const strongest = (from: number, to: number): number | null => {
    const lo = Math.max(0, Math.round(from));
    const hi = Math.min(flux.length - 1, Math.round(to));
    let bestIndex = -1;
    let best = floor;
    for (let i = lo; i <= hi; i++) {
      if (flux[i] > best) {
        best = flux[i];
        bestIndex = i;
      }
    }
    return bestIndex < 0 ? null : bestIndex;
  };

  const anchor = (centre: number): number | null =>
    strongest(centre - tolerance, centre + tolerance);

  // The downbeat is the strongest onset in the *whole* first beat, not a
  // tolerance window around one guess — a clip that opens exactly on the hit
  // has it at zero, which a window centred half a beat in cannot see.
  const first = strongest(0, period);
  if (first == null) {
    return [];
  }

  const beats: number[] = [first];
  let previous = first;
  for (;;) {
    const predicted = previous + period;
    if (predicted > flux.length - 1) {
      break;
    }
    const found = anchor(predicted);
    previous = found ?? predicted;
    beats.push(previous);
  }

  return beats.map((hop) => Math.round(hop * hopMs));
}

/**
 * An envelope reduced to at most `maxPoints`, for returning to an agent.
 *
 * Tool output is capped at 25,000 tokens, and a five-minute clip at a 10ms hop
 * is 30,000 numbers — enough to blow that budget several times over on its own.
 * Buckets keep the **peak**, not the mean: the reason to look at an envelope is
 * to find the loud moment, and averaging is precisely what hides it.
 */
export function downsampleEnvelope(
  envelope: Envelope,
  maxPoints: number,
): Envelope {
  const { hopMs, db } = envelope;
  if (db.length <= maxPoints || maxPoints < 1) {
    return envelope;
  }

  const factor = Math.ceil(db.length / maxPoints);
  const out: number[] = [];
  for (let i = 0; i < db.length; i += factor) {
    let peak = FLOOR_DB;
    for (let j = i; j < Math.min(db.length, i + factor); j++) {
      if (db[j] > peak) {
        peak = db[j];
      }
    }
    out.push(Math.round(peak));
  }

  return { hopMs: hopMs * factor, db: out };
}

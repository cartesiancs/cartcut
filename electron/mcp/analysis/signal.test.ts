/**
 * The signal maths, against signals whose answer is known by construction.
 *
 * A click track at 120 BPM has to come back as 120 BPM. That is the only kind
 * of test worth having here: an assertion against a recording would pin
 * whatever the code happened to produce the day it was written, which is not
 * the same as pinning that it is right.
 */

import { describe, it, expect } from "vitest";
import {
  FLOOR_DB,
  detectOnsets,
  downsampleEnvelope,
  estimateTempo,
  onsetStrength,
  rmsEnvelope,
  silentRanges,
  trackBeats,
} from "./signal";

const RATE = 16_000;

function silence(ms: number): number[] {
  return new Array(Math.round((ms * RATE) / 1000)).fill(0);
}

/** A short burst of noise: a click, as far as an energy detector is concerned. */
function click(ms = 20, amplitude = 0.8): number[] {
  const length = Math.round((ms * RATE) / 1000);
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    // Decaying, so it reads as a percussive hit rather than a tone starting.
    const decay = 1 - i / length;
    out.push(amplitude * decay * (i % 2 === 0 ? 1 : -1));
  }
  return out;
}

function tone(ms: number, amplitude = 0.5, hz = 220): number[] {
  const length = Math.round((ms * RATE) / 1000);
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    out.push(amplitude * Math.sin((2 * Math.PI * hz * i) / RATE));
  }
  return out;
}

/** Clicks every `periodMs`, for `count` of them. */
function clickTrack(periodMs: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const hit = click();
    out.push(...hit);
    out.push(...silence(periodMs - hit.length / (RATE / 1000)));
  }
  return out;
}

describe("rmsEnvelope", () => {
  it("floors digital silence rather than returning -Infinity", () => {
    const envelope = rmsEnvelope(silence(200), RATE);
    expect(envelope.db.every((v) => v === FLOOR_DB)).toBe(true);
  });

  it("reports a full-scale square wave at about 0 dBFS", () => {
    const samples = new Array(RATE).fill(0).map((_, i) => (i % 2 ? 1 : -1));
    const envelope = rmsEnvelope(samples, RATE);
    // RMS of ±1 is 1, which is 0 dBFS.
    expect(Math.max(...envelope.db)).toBeCloseTo(0, 5);
  });

  it("puts a hop's worth of ms between consecutive entries", () => {
    const envelope = rmsEnvelope(tone(1_000), RATE, 10);
    expect(envelope.hopMs).toBe(10);
    // One second at a 10ms hop.
    expect(envelope.db.length).toBeCloseTo(100, -1);
  });

  it("sees a quiet passage as quieter than a loud one", () => {
    const loud = rmsEnvelope(tone(200, 0.9), RATE);
    const quiet = rmsEnvelope(tone(200, 0.02), RATE);
    expect(Math.max(...loud.db)).toBeGreaterThan(Math.max(...quiet.db));
  });
});

describe("silentRanges", () => {
  it("finds a gap between two sounds", () => {
    const samples = [...tone(500), ...silence(800), ...tone(500)];
    const ranges = silentRanges(rmsEnvelope(samples, RATE));

    expect(ranges).toHaveLength(1);
    expect(ranges[0].startMs).toBeGreaterThanOrEqual(480);
    expect(ranges[0].startMs).toBeLessThanOrEqual(540);
    expect(ranges[0].endMs - ranges[0].startMs).toBeGreaterThan(700);
  });

  it("ignores a gap shorter than the minimum", () => {
    const samples = [...tone(400), ...silence(100), ...tone(400)];
    expect(silentRanges(rmsEnvelope(samples, RATE), -40, 300)).toEqual([]);
  });

  it("closes a run that reaches the end of the signal", () => {
    const samples = [...tone(300), ...silence(900)];
    const ranges = silentRanges(rmsEnvelope(samples, RATE));
    expect(ranges).toHaveLength(1);
    expect(ranges[0].endMs).toBeGreaterThan(1_000);
  });

  it("returns nothing for a signal that never goes quiet", () => {
    expect(silentRanges(rmsEnvelope(tone(1_000), RATE))).toEqual([]);
  });
});

describe("onsetStrength", () => {
  it("rectifies: a sound ending is not an onset", () => {
    const samples = [...silence(200), ...tone(400), ...silence(400)];
    const flux = onsetStrength(rmsEnvelope(samples, RATE));
    expect(flux.every((v) => v >= 0)).toBe(true);
  });
});

describe("detectOnsets", () => {
  it("finds one onset per click in a click track", () => {
    // 8 clicks, 500ms apart.
    const onsets = detectOnsets(rmsEnvelope(clickTrack(500, 8), RATE));
    expect(onsets.length).toBe(8);
  });

  it("places them on the clicks", () => {
    const onsets = detectOnsets(rmsEnvelope(clickTrack(500, 6), RATE));
    onsets.forEach((at, index) => {
      // Within one hop of where the click was written.
      expect(Math.abs(at - index * 500)).toBeLessThanOrEqual(20);
    });
  });

  it("does not report one hit several times as it decays", () => {
    const samples = [...silence(200), ...click(60), ...silence(600)];
    expect(detectOnsets(rmsEnvelope(samples, RATE)).length).toBe(1);
  });

  it("finds the hit a file opens on", () => {
    // A clip trimmed hard onto the downbeat: there is no rise inside the
    // signal, so differencing from the first sample used to lose this one.
    const samples = [...click(), ...silence(600), ...click(), ...silence(600)];
    const onsets = detectOnsets(rmsEnvelope(samples, RATE));

    expect(onsets.length).toBe(2);
    expect(onsets[0]).toBeLessThanOrEqual(20);
  });

  it("finds nothing in silence", () => {
    expect(detectOnsets(rmsEnvelope(silence(2_000), RATE))).toEqual([]);
  });

  it("does not invent an onset from a file that opens in silence", () => {
    const samples = [...silence(600), ...click(), ...silence(600)];
    const onsets = detectOnsets(rmsEnvelope(samples, RATE));

    expect(onsets.length).toBe(1);
    expect(onsets[0]).toBeGreaterThan(500);
  });

  it("finds nothing in a steady tone, which never rises", () => {
    const onsets = detectOnsets(rmsEnvelope(tone(2_000), RATE));
    // The tone's own start is allowed; nothing after it is.
    expect(onsets.length).toBeLessThanOrEqual(1);
  });
});

describe("estimateTempo", () => {
  it("recovers 120 BPM from a click track at 120 BPM", () => {
    // 120 BPM is a beat every 500ms.
    const tempo = estimateTempo(rmsEnvelope(clickTrack(500, 24), RATE));
    expect(tempo).not.toBeNull();
    expect(tempo!.bpm).toBeGreaterThan(118);
    expect(tempo!.bpm).toBeLessThan(122);
  });

  it("recovers 100 BPM from a click track at 100 BPM", () => {
    const tempo = estimateTempo(rmsEnvelope(clickTrack(600, 20), RATE));
    expect(tempo).not.toBeNull();
    expect(tempo!.bpm).toBeGreaterThan(98);
    expect(tempo!.bpm).toBeLessThan(102);
  });

  it("is more confident about a click track than about a steady tone", () => {
    const pulse = estimateTempo(rmsEnvelope(clickTrack(500, 24), RATE));
    const flat = estimateTempo(rmsEnvelope(tone(12_000), RATE));

    expect(pulse).not.toBeNull();
    expect(pulse!.confidence).toBeGreaterThan(0.5);
    // A signal with no pulse must not come back as a confident wrong answer.
    if (flat != null) {
      expect(flat.confidence).toBeLessThan(pulse!.confidence);
    }
  });

  it("does not report the half-tempo of a steady pulse", () => {
    // Autocorrelation scores a period and its double almost equally, and on a
    // period that does not land on the hop grid the double can win outright —
    // which reported 64bpm for a real 128bpm metronome.
    const tempo = estimateTempo(rmsEnvelope(clickTrack(469, 60), RATE));
    // 469ms is 128 bpm. The half would be 64.
    expect(tempo!.bpm).toBeGreaterThan(120);
    expect(tempo!.bpm).toBeLessThan(136);
  });

  it("declines a signal too short to hold two slow periods", () => {
    expect(estimateTempo(rmsEnvelope(clickTrack(500, 2), RATE))).toBeNull();
  });
});

describe("trackBeats", () => {
  it("puts a beat on every click of a click track", () => {
    // 469ms is 128bpm, and deliberately not a whole number of 10ms hops — the
    // case where extrapolating from a rate drifts off the beat.
    const beats = trackBeats(rmsEnvelope(clickTrack(469, 60), RATE), 128);

    expect(beats.length).toBeGreaterThanOrEqual(58);
    expect(beats.length).toBeLessThanOrEqual(61);
  });

  it("does not drift over a long track", () => {
    // The whole reason this function exists. Extrapolating a rate walked 370ms
    // off by the end of a minute; re-anchoring keeps every beat on its click.
    const beats = trackBeats(rmsEnvelope(clickTrack(469, 60), RATE), 128);

    beats.forEach((at, index) => {
      expect(Math.abs(at - index * 469)).toBeLessThanOrEqual(25);
    });
  });

  it("starts on the first hit rather than somewhere in the bar", () => {
    const beats = trackBeats(rmsEnvelope(clickTrack(469, 60), RATE), 128);
    expect(beats[0]).toBeLessThanOrEqual(30);
  });

  it("rides through a gap without losing the grid", () => {
    // Four beats, four beats of nothing, four beats. The prediction carries the
    // chain across the hole, and the clicks after it still get beats — which is
    // the part that fails if a gap is allowed to reset the phase.
    const samples = [
      ...clickTrack(500, 4),
      ...silence(2_000),
      ...clickTrack(500, 4),
    ];
    const beats = trackBeats(rmsEnvelope(samples, RATE), 120);

    // Clicks resume at 4000 and run 4000, 4500, 5000, 5500.
    for (const click of [4_000, 4_500, 5_000, 5_500]) {
      const nearest = Math.min(...beats.map((b) => Math.abs(b - click)));
      expect(nearest).toBeLessThanOrEqual(60);
    }
  });

  it("returns nothing for silence", () => {
    expect(trackBeats(rmsEnvelope(silence(4_000), RATE), 120)).toEqual([]);
  });

  it("returns nothing for a nonsensical rate", () => {
    expect(trackBeats(rmsEnvelope(clickTrack(500, 8), RATE), 0)).toEqual([]);
  });
});

describe("downsampleEnvelope", () => {
  it("leaves a short envelope alone, by identity", () => {
    const envelope = rmsEnvelope(tone(200), RATE);
    expect(downsampleEnvelope(envelope, 1_000)).toBe(envelope);
  });

  it("comes in under the cap and widens the hop to match", () => {
    const envelope = rmsEnvelope(tone(60_000), RATE, 10);
    const small = downsampleEnvelope(envelope, 200);

    expect(small.db.length).toBeLessThanOrEqual(200);
    expect(small.hopMs).toBeGreaterThan(10);
    // The envelope still spans the same wall-clock time.
    expect(small.db.length * small.hopMs).toBeGreaterThan(55_000);
  });

  it("keeps the peak of each bucket, not its mean", () => {
    // One loud hop buried in quiet: averaging would hide it.
    const samples = [...silence(500), ...tone(30, 0.9), ...silence(500)];
    const small = downsampleEnvelope(rmsEnvelope(samples, RATE, 10), 8);
    expect(Math.max(...small.db)).toBeGreaterThan(-20);
  });
});

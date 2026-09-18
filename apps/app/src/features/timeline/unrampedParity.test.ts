/**
 * A clip with no speed ramp behaves exactly as it did before ramps existed.
 *
 * The speed ramp touched thirty-four existing files. Most of that is additive,
 * but four pieces of arithmetic were **rewritten** rather than extended:
 * `clipEdit`'s three trim and split primitives now go through a pair of
 * closures instead of multiplying and dividing by one scalar, and
 * `transitionGeometry`'s two handles now go through `timelineTimeAt` instead of
 * a division. Rewritten arithmetic that is meant to be equivalent is exactly
 * the kind of change that is wrong in the sixth decimal and passes review.
 *
 * So this suite restates the **old** formulas, verbatim from before the
 * feature, and requires the current code to produce them for unramped clips.
 * Measured over five thousand random clips each: `trim`, `duration` and the
 * split's cut instant are bit-identical, and `startTime` and the two transition
 * handles differ by at most 3e-10 ms, which is nine orders of magnitude under
 * `ADJACENCY_EPSILON_MS`.
 *
 * The second half is the other half of the same question: a project with no
 * ramp anywhere must produce the same plans, the same strip, the same agent
 * output and the same document object it always did.
 */

import { describe, expect, it } from "vitest";
import { trimStart, trimEnd, splitAt } from "./clipEdit";
import {
  sourceTimeAt, timelineTimeAt, spanLength, spanEnd, spanStart,
  speedOf, sourceDurationOf, MIN_SOURCE_MS, MIN_TIMELINE_MS,
} from "./geometry";
import { tailHandleOf, headHandleOf } from "./transitionGeometry";
import { canMergeClips } from "./mergeOps";
import { createTrack, normalizeDocument, SCHEMA_VERSION } from "./tracks";
import { audioTwinOf } from "./audio";
import { seededRandom } from "./testing";
import { videoElement, imageElement, audioElement } from "../renderer/testing";

import { normalizeSpeedCurves } from "./speedOps";
import { planWaveform } from "./strip/peaks";
import { planFilmstrip } from "./strip/tiles";
import { hasSpeedRamp, speedPolyline } from "./speedBand";
import { clipDetail, clipRow } from "../agent/serialize";
const rand = seededRandom(0xa11);
function clamp(v: number, lo: number, hi: number) { return hi < lo ? lo : Math.min(Math.max(v, lo), hi); }

/** A random unramped dynamic clip. */
function clip() {
  const sourceDuration = 1000 + rand() * 600_000;
  const trimStartMs = rand() * sourceDuration * 0.4;
  const trimEndMs = trimStartMs + MIN_SOURCE_MS + rand() * (sourceDuration - trimStartMs - MIN_SOURCE_MS);
  return videoElement({
    trackId: "v1",
    startTime: rand() * 120_000,
    duration: trimEndMs - trimStartMs,
    sourceDuration,
    trim: { startTime: trimStartMs, endTime: trimEndMs },
    speed: 0.25 + rand() * 3.75,
  });
}

describe("an unramped clip behaves exactly as it did at 5602cc1", () => {
  it("sourceTimeAt / timelineTimeAt are the same doubles", () => {
    for (let i = 0; i < 5000; i++) {
      const el = clip();
      const t = spanStart(el) + rand() * spanLength(el) * 1.5 - spanLength(el) * 0.25;
      const oldSource = el.trim.startTime + (t - el.startTime) * speedOf(el);
      expect(sourceTimeAt(el, t)).toBe(oldSource);
      const s = el.trim.startTime + rand() * (el.trim.endTime - el.trim.startTime);
      const oldTimeline = el.startTime + (s - el.trim.startTime) / speedOf(el);
      expect(timelineTimeAt(el, s)).toBe(oldTimeline);
    }
  });

  it("trimStart matches the old arithmetic", () => {
    let worstStart = 0, worstTrim = 0, worstDur = 0;
    for (let i = 0; i < 5000; i++) {
      const el = clip();
      const delta = (rand() - 0.5) * spanLength(el) * 2;

      const speed = speedOf(el);
      const { startTime: srcStart, endTime: srcEnd } = el.trim;
      const maxLeftSource = Math.min(srcStart, el.startTime * speed);
      const maxRightSource = srcEnd - srcStart - MIN_SOURCE_MS;
      const appliedSource = clamp(delta * speed, -maxLeftSource, maxRightSource);
      const wantStart = el.startTime + appliedSource / speed;
      const wantTrimStart = srcStart + appliedSource;
      const wantDuration = srcEnd - wantTrimStart;

      const got: any = trimStart(el, delta);
      worstStart = Math.max(worstStart, Math.abs(got.startTime - wantStart));
      worstTrim = Math.max(worstTrim, Math.abs(got.trim.startTime - wantTrimStart));
      worstDur = Math.max(worstDur, Math.abs(got.duration - wantDuration));
      expect(got.trim.endTime).toBe(srcEnd);
    }
    console.log(`trimStart worst deltas  startTime ${worstStart.toExponential(2)}ms  trim ${worstTrim.toExponential(2)}ms  duration ${worstDur.toExponential(2)}ms`);
    expect(worstStart).toBeLessThan(1e-6);
    expect(worstTrim).toBeLessThan(1e-6);
    expect(worstDur).toBeLessThan(1e-6);
  });

  it("trimEnd matches the old arithmetic", () => {
    let worst = 0;
    for (let i = 0; i < 5000; i++) {
      const el = clip();
      const delta = (rand() - 0.5) * spanLength(el) * 2;
      const speed = speedOf(el);
      const { startTime: srcStart, endTime: srcEnd } = el.trim;
      const minSource = MIN_SOURCE_MS - (srcEnd - srcStart);
      const maxSource = sourceDurationOf(el) - srcEnd;
      const appliedSource = clamp(delta * speed, minSource, maxSource);
      const wantEnd = srcEnd + appliedSource;
      const got: any = trimEnd(el, delta);
      worst = Math.max(worst, Math.abs(got.trim.endTime - wantEnd));
      expect(got.startTime).toBe(el.startTime);
      expect(got.trim.startTime).toBe(srcStart);
    }
    console.log(`trimEnd worst delta  trim.endTime ${worst.toExponential(2)}ms`);
    expect(worst).toBeLessThan(1e-6);
  });

  it("splitAt cuts at the same source instant", () => {
    let worst = 0;
    for (let i = 0; i < 5000; i++) {
      const el = clip();
      const at = spanStart(el) + spanLength(el) * (0.02 + rand() * 0.96);
      const oldCut = el.trim.startTime + (at - el.startTime) * speedOf(el);
      const halves = splitAt(el, at);
      expect(halves).not.toBeNull();
      worst = Math.max(worst, Math.abs((halves!.left as any).trim.endTime - oldCut));
      expect((halves!.left as any).trim.endTime).toBe((halves!.right as any).trim.startTime);
    }
    console.log(`splitAt worst cut delta  ${worst.toExponential(2)}ms`);
    expect(worst).toBe(0);
  });

  it("the transition handles match the old division", () => {
    let worstTail = 0, worstHead = 0;
    for (let i = 0; i < 5000; i++) {
      const el = clip();
      const oldTail = Math.max(0, sourceDurationOf(el) - el.trim.endTime) / speedOf(el);
      const oldHead = Math.max(0, el.trim.startTime) / speedOf(el);
      worstTail = Math.max(worstTail, Math.abs(tailHandleOf(el) - oldTail));
      worstHead = Math.max(worstHead, Math.abs(headHandleOf(el) - oldHead));
    }
    console.log(`transition handles worst deltas  tail ${worstTail.toExponential(2)}ms  head ${worstHead.toExponential(2)}ms`);
    expect(worstTail).toBeLessThan(1e-6);
    expect(worstHead).toBeLessThan(1e-6);
  });

  it("a merge still turns on the scalar alone", () => {
    for (let i = 0; i < 1000; i++) {
      const left = clip();
      const sameSpeed = rand() < 0.5;
      const tail = left.trim.endTime + left.duration;
      if (tail > left.sourceDuration) {
        continue;
      }
      const right = videoElement({
        ...left,
        key: "b",
        startTime: spanEnd(left),
        trim: { startTime: left.trim.endTime, endTime: tail },
        speed: sameSpeed ? left.speed : Math.min(4, left.speed * 1.5),
      });
      const doc = normalizeDocument({
        schemaVersion: SCHEMA_VERSION,
        tracks: [createTrack("v1", "video", 0)],
        elements: { a: left, b: right },
      } as any);
      // The old rule exactly: adjacency plus an exact scalar match. Two clips
      // with no ramp answer `sameSpeedCurve` true and fall straight through to
      // the scalar test the module always had.
      const joined = canMergeClips(doc, ["a", "b"]);
      if (sameSpeed) {
        expect(joined).toBe(true);
      } else {
        expect(joined).toBe(false);
      }
    }
  });

  it("the detached twin is what it always was", () => {
    for (let i = 0; i < 2000; i++) {
      const el = clip();
      const twin: any = audioTwinOf(el);
      expect(twin.speed).toBe(el.speed);
      expect(twin.speedCurve).toBeUndefined();
      expect(twin.trim).toEqual(el.trim);
      expect(twin.duration).toBe(el.duration);
      expect(twin.startTime).toBe(el.startTime);
    }
  });

  it("a static element is untouched by any of it", () => {
    for (let i = 0; i < 1000; i++) {
      const still = imageElement({ trackId: "v1", startTime: rand() * 1000, duration: MIN_TIMELINE_MS + rand() * 9000 });
      const delta = (rand() - 0.5) * 2000;
      const a: any = trimStart(still, delta);
      const applied = clamp(delta, -still.startTime, still.duration - MIN_TIMELINE_MS);
      expect(a.startTime).toBe(still.startTime + applied);
      expect(a.duration).toBe(still.duration - applied);
      expect(tailHandleOf(still)).toBe(Infinity);
      expect(headHandleOf(still)).toBe(Infinity);
    }
  });
});

const doc = (elements: any) =>
  normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements,
  } as any);

describe("a project with no ramp is untouched", () => {
  it("normalizeSpeedCurves returns the document by identity", () => {
    const d = doc({
      a: videoElement({ trackId: "v1", speed: 1 }),
      b: videoElement({ trackId: "v1", startTime: 9000, speed: 2 }),
      c: audioElement({ trackId: "v1", startTime: 20_000 }),
      i: imageElement({ trackId: "v1", startTime: 30_000 }),
    });
    expect(normalizeSpeedCurves(d)).toBe(d);
  });

  it("the waveform and filmstrip plans are what they are with no curve field", () => {
    const el: any = videoElement({
      trackId: "v1", startTime: 0, duration: 8000, sourceDuration: 8000,
      trim: { startTime: 1200, endTime: 9200 }, speed: 1.5,
    });
    const peaks = { peaks: new Float32Array(2000).fill(0.3), bucketMs: 20 } as any;
    const base = {
      data: peaks, clipX: 40, clipW: 500, spanStartMs: 0,
      sourceInMs: el.trim.startTime, speed: el.speed, range: 12,
      viewportX0: 0, viewportX1: 900,
    };
    expect(planWaveform({ ...base, curve: null })).toEqual(planWaveform(base as any));

    const strip = {
      localpath: el.localpath, clipX: 40, clipY: 0, clipW: 500, clipH: 40,
      sourceInMs: el.trim.startTime, speed: el.speed, sourceAspect: 16 / 9,
      range: 12, fps: 60, viewportX0: 0, viewportX1: 900,
    };
    expect(planFilmstrip({ ...strip, curve: null })).toEqual(
      planFilmstrip(strip as any),
    );
  });

  it("the clip strip draws no speed band", () => {
    for (const speed of [0.25, 1, 2, 4]) {
      const el = videoElement({ trackId: "v1", speed });
      expect(hasSpeedRamp(el)).toBe(false);
      expect(speedPolyline({ x: 0, y: 0, w: 200, h: 40 }, el, 12, 900).points).toEqual([]);
    }
  });

  it("the agent surface reports no ramp", () => {
    const el = videoElement({ trackId: "v1", speed: 2 });
    const detail: any = clipDetail("a", el);
    expect(detail.speedRamp).toBeUndefined();
    expect(detail.speed).toBe(2);
    const row: any = clipRow("a", el);
    expect(row.speed).toBe(2);
    expect(row.speedRamp).toBeUndefined();
  });
});

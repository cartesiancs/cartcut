/**
 * A ramped clip put through the whole editing surface, at random, many times.
 *
 * The speed ramp introduces a second derived field. `trim` already had one
 * (`duration`) and `assertTrimInvariant` guards it; now `speed` is authored on a
 * clip with no ramp and *derived* on one that has it, and the model only holds
 * while every op that moves the trim window re-derives it. Enumerating the ops
 * that do proves nothing about the one somebody adds next, so this sweeps them
 * instead, asserting both invariants after every single step.
 *
 * Four properties beyond the invariants, each protecting something specific:
 *
 *  - **the edges agree**. The curve and the derived scalar give the same source
 *    instant at both ends of the clip and differ only inside. That is what makes
 *    a call site nobody generalised show a slightly wrong frame mid-clip rather
 *    than a wrong length, a wrong collision or a desynced export, and it is the
 *    single assumption the whole design rests on;
 *  - **a split reconstructs**. The two halves' spans sum to the original's,
 *    which is `curveSpanLength`'s additivity reaching all the way out to the
 *    document;
 *  - **a reverse round trips**. `applyReverse` and `unreverse` reflect the ramp
 *    about the same axis, so trim, curve and scalar all come back;
 *  - **the ramp survives a trim**. Points are absolute source ms and are never
 *    clipped to the window, so trimming in and back out restores the ramp
 *    instead of flattening it one edit at a time.
 */

import { describe, expect, it } from "vitest";
import {
  assertSpeedInvariant,
  assertTrimInvariant,
  ADJACENCY_EPSILON_MS,
  sourceTimeAt,
  spanEnd,
  spanLength,
  spanOf,
  spanStart,
  speedOf,
  timelineTimeAt,
} from "./geometry";
import { splitAt, trimEnd, trimStart, withSpeedCurve } from "./clipEdit";
import { splitClip } from "./clipOps";
import { canMergeClips, mergeClips } from "./mergeOps";
import { applyReverse, unreverse } from "./reverseOps";
import { audioTwinOf } from "./audio";
import { setClipSpeed, setClipSpeedCurve } from "./speedOps";
import {
  curveSpanLength,
  MAX_SPEED,
  MIN_CURVE_GAP_MS,
  MIN_SPEED,
  sameSpeedCurve,
  speedCurveOf,
  type SpeedPoint,
} from "./speedCurve";
import {
  clipsOnTrack,
  createTrack,
  normalizeDocument,
  SCHEMA_VERSION,
  type TimelineDocument,
} from "./tracks";
import { seededRandom } from "./testing";
import { videoElement } from "../renderer/testing";
import type { TimelineElement, VideoElementType } from "../../@types/timeline";

const SOURCE_MS = 12_000;

function doc(elements: Record<string, TimelineElement>): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements,
  } as TimelineDocument);
}

/** A random ramp across the whole source file, so a trim always lands inside it. */
function randomRamp(rand: () => number): SpeedPoint[] {
  const count = 2 + Math.floor(rand() * 5);
  const points: SpeedPoint[] = [];
  for (let i = 0; i < count; i++) {
    points.push({
      t: (SOURCE_MS * i) / (count - 1),
      v: MIN_SPEED + rand() * (MAX_SPEED - MIN_SPEED),
    });
  }
  // Two points that happen to land on the same rate would read as flat and be
  // rejected, which would silently turn a ramped case into an unramped one.
  if (points.every((point) => Math.abs(point.v - points[0].v) < 1e-6)) {
    points[points.length - 1] = { t: SOURCE_MS, v: points[0].v === MAX_SPEED ? MIN_SPEED : MAX_SPEED };
  }
  return points;
}

function rampedClip(rand: () => number, startTime = 0): VideoElementType {
  const base = videoElement({
    trackId: "v1",
    startTime,
    duration: SOURCE_MS,
    sourceDuration: SOURCE_MS,
    trim: { startTime: 0, endTime: SOURCE_MS },
    speed: 1,
  });
  return withSpeedCurve(base, randomRamp(rand));
}

/** Everything that must be true of a ramped clip, whatever was just done to it. */
function faults(element: TimelineElement, context: string): string[] {
  const out: string[] = [];

  try {
    assertTrimInvariant(element, context);
  } catch (error) {
    out.push(String((error as Error).message));
  }
  try {
    assertSpeedInvariant(element, context);
  } catch (error) {
    out.push(String((error as Error).message));
  }

  const speed = speedOf(element);
  if (!(speed >= MIN_SPEED && speed <= MAX_SPEED)) {
    out.push(`${context}: speed ${speed} is outside the range`);
  }
  const length = spanLength(element);
  if (!(length > 0) || !Number.isFinite(length)) {
    out.push(`${context}: span is ${length}`);
  }

  const curve = speedCurveOf(element);
  if (curve != null) {
    for (let i = 1; i < curve.points.length; i++) {
      if (!(curve.points[i].t > curve.points[i - 1].t)) {
        out.push(`${context}: ramp is not strictly ascending at ${i}`);
      }
    }

    const dynamic = element as VideoElementType;
    // The property every ungeneralised call site depends on.
    const atStart = sourceTimeAt(dynamic, spanStart(element));
    const atEnd = sourceTimeAt(dynamic, spanEnd(element));
    if (Math.abs(atStart - dynamic.trim.startTime) > 1e-6) {
      out.push(
        `${context}: left edge shows source ${atStart}, expected ${dynamic.trim.startTime}`,
      );
    }
    if (Math.abs(atEnd - dynamic.trim.endTime) > 1e-6) {
      out.push(
        `${context}: right edge shows source ${atEnd}, expected ${dynamic.trim.endTime}`,
      );
    }
    // And its inverse, which the transcript and tracker paths read.
    const back = timelineTimeAt(dynamic, dynamic.trim.endTime);
    if (Math.abs(back - spanEnd(element)) > 1e-6) {
      out.push(`${context}: the out-point maps back to ${back}, not ${spanEnd(element)}`);
    }

    const want = curveSpanLength(
      curve,
      dynamic.trim.startTime,
      dynamic.trim.endTime,
    );
    if (Math.abs(want - length) > 1e-6) {
      out.push(`${context}: span ${length} where the ramp asks for ${want}`);
    }
  }

  return out;
}

describe("a ramped clip under random editing", () => {
  it("holds both invariants through every op, over 200 seeded runs", () => {
    for (let seed = 0; seed < 200; seed++) {
      const rand = seededRandom(seed + 1);
      let document = doc({ a: rampedClip(rand) });
      const trail: string[] = [];

      for (let step = 0; step < 8; step++) {
        const ids = Object.keys(document.elements);
        const id = ids[Math.floor(rand() * ids.length)];
        const element = document.elements[id];
        if (element == null) {
          continue;
        }

        const pick = Math.floor(rand() * 6);
        const before = document;

        if (pick === 0) {
          const next = trimStart(element, (rand() - 0.3) * 4000);
          document = doc({ ...document.elements, [id]: next });
          trail.push(`trimStart(${id})`);
        } else if (pick === 1) {
          const next = trimEnd(element, (rand() - 0.7) * 4000);
          document = doc({ ...document.elements, [id]: next });
          trail.push(`trimEnd(${id})`);
        } else if (pick === 2) {
          const at = spanStart(element) + spanLength(element) * rand();
          document = splitClip(document, id, at, `${id}-${step}`);
          trail.push(`split(${id} at ${at.toFixed(2)})`);
        } else if (pick === 3) {
          const lane = clipsOnTrack(document, "v1").map(([clipId]) => clipId);
          if (lane.length >= 2 && canMergeClips(document, lane.slice(0, 2))) {
            document = mergeClips(document, lane.slice(0, 2));
            trail.push(`merge(${lane.slice(0, 2).join(",")})`);
          }
        } else if (pick === 4) {
          document = setClipSpeedCurve(document, id, randomRamp(rand), {
            ripple: true,
          });
          trail.push(`setCurve(${id})`);
        } else {
          document = setClipSpeed(document, id, MIN_SPEED + rand() * 3.75, {
            ripple: true,
          });
          trail.push(`setSpeed(${id})`);
        }

        const found: string[] = [];
        for (const [clipId, clip] of Object.entries(document.elements)) {
          found.push(...faults(clip, clipId));
        }
        if (found.length > 0) {
          throw new Error(
            `seed ${seed} after ${trail.join(" -> ")}:\n  ${found.join("\n  ")}`,
          );
        }
        expect(document).not.toBe(undefined);
        void before;
      }
    }
  });

  it("splits into halves that reconstruct the original span", () => {
    for (let seed = 0; seed < 300; seed++) {
      const rand = seededRandom(seed + 1000);
      const element = rampedClip(rand, 3000);
      const span = spanOf(element);
      const at = span.start + span.length * (0.05 + rand() * 0.9);

      const halves = splitAt(element, at);
      expect(halves).not.toBeNull();
      const { left, right } = halves!;

      expect(faults(left, "left")).toEqual([]);
      expect(faults(right, "right")).toEqual([]);

      // Adjacent on the timeline, to the slack the rest of the codebase
      // reconciles spans with.
      expect(Math.abs(spanEnd(left) - spanStart(right))).toBeLessThan(
        ADJACENCY_EPSILON_MS,
      );
      expect(Math.abs(spanEnd(right) - span.end)).toBeLessThan(
        ADJACENCY_EPSILON_MS,
      );
      // No footage gained or lost, and this one is exact: `duration` is source
      // ms and the two windows abut.
      expect(left.duration + right.duration).toBeCloseTo(element.duration, 6);
      expect((left as VideoElementType).trim.endTime).toBe(
        (right as VideoElementType).trim.startTime,
      );
      // Both halves carry the same ramp, which is what lets them be rejoined.
      expect(
        sameSpeedCurve(
          (left as VideoElementType).speedCurve,
          (right as VideoElementType).speedCurve,
        ),
      ).toBe(true);
    }
  });

  it("rejoins the halves of a ramped split", () => {
    const rand = seededRandom(31);
    for (let i = 0; i < 100; i++) {
      const element = rampedClip(rand);
      const span = spanOf(element);
      const before = doc({ a: element });
      const cut = splitClip(before, "a", span.start + span.length * 0.4, "b");
      const lane = clipsOnTrack(cut, "v1").map(([id]) => id);
      expect(lane.length).toBe(2);

      // The two halves have different derived means by construction, so a
      // scalar comparison here would refuse every ramped clip.
      expect(speedOf(cut.elements[lane[0]])).not.toBeCloseTo(
        speedOf(cut.elements[lane[1]]),
        6,
      );
      expect(canMergeClips(cut, lane)).toBe(true);

      const rejoined = mergeClips(cut, lane);
      const merged = clipsOnTrack(rejoined, "v1");
      expect(merged.length).toBe(1);
      expect(faults(merged[0][1], "merged")).toEqual([]);
      expect(spanLength(merged[0][1])).toBeCloseTo(span.length, 6);
      expect(speedOf(merged[0][1])).toBeCloseTo(speedOf(element), 9);
    }
  });

  it("carries the ramp onto a detached audio twin, at the twin's own rate", () => {
    const rand = seededRandom(555);
    for (let i = 0; i < 100; i++) {
      const video = rampedClip(rand);
      const trimmed = trimStart(video, 1500) as VideoElementType;
      const twin = audioTwinOf(trimmed);

      expect(faults(twin, "twin")).toEqual([]);
      expect(sameSpeedCurve(twin.speedCurve, trimmed.speedCurve)).toBe(true);
      // Derived from its own window rather than copied, though here the windows
      // match so the two agree. A twin at the video's mean against a ramping
      // picture is lip sync drifting by seconds with nothing saying so.
      expect(twin.speed).toBeCloseTo(trimmed.speed, 9);
      expect(twin.speedCurve).not.toBe(trimmed.speedCurve);
      // Frame for frame, the sound and the picture agree throughout the clip,
      // which a constant-rate twin would only manage at the two ends.
      for (let t = 0; t <= 1; t += 0.1) {
        const at = spanStart(trimmed) + spanLength(trimmed) * t;
        expect(sourceTimeAt(twin, at)).toBeCloseTo(sourceTimeAt(trimmed, at), 6);
      }
    }
  });

  it("round trips a reverse, ramp and all", () => {
    const rand = seededRandom(909);
    for (let i = 0; i < 100; i++) {
      const element = rampedClip(rand);
      const trimmed = trimStart(
        trimEnd(element, -1000) as VideoElementType,
        1200,
      ) as VideoElementType;
      const before = doc({ a: trimmed });

      const reversed = applyReverse(
        before,
        "a",
        { localpath: trimmed.localpath, trim: { ...trimmed.trim } },
        {
          localpath: "file:///tmp/asset.reversed.mp4",
          durationMs: trimmed.duration,
          hasAudio: true,
        },
      );
      const mid = reversed.elements.a as VideoElementType;
      expect(mid.localpath).toBe("file:///tmp/asset.reversed.mp4");
      expect(faults(mid, "reversed")).toEqual([]);
      // Reflecting leaves the window's integral alone, so the clip keeps its
      // length. If the mirror were wrong, this is what would move.
      expect(spanLength(mid)).toBeCloseTo(spanLength(trimmed), 6);
      expect(mid.speed).toBeCloseTo(trimmed.speed, 9);

      const back = unreverse(reversed, "a").elements.a as VideoElementType;
      expect(faults(back, "unreversed")).toEqual([]);
      expect(back.localpath).toBe(trimmed.localpath);
      expect(back.trim.startTime).toBeCloseTo(trimmed.trim.startTime, 6);
      expect(back.trim.endTime).toBeCloseTo(trimmed.trim.endTime, 6);
      expect(sameSpeedCurve(back.speedCurve, trimmed.speedCurve)).toBe(true);
      expect(back.speed).toBeCloseTo(trimmed.speed, 9);
    }
  });

  it("restores the ramp when a trim is dragged back out", () => {
    const rand = seededRandom(1234);
    for (let i = 0; i < 100; i++) {
      const element = rampedClip(rand, 5000);
      const inward = trimStart(element, 2500) as VideoElementType;
      const outward = trimStart(inward, -2500) as VideoElementType;

      expect(faults(outward, "restored")).toEqual([]);
      expect(outward.trim.startTime).toBeCloseTo(element.trim.startTime, 6);
      // Points are absolute source ms and are never clipped to the window, so
      // the shape comes back rather than flattening one edit at a time.
      expect(sameSpeedCurve(outward.speedCurve, element.speedCurve)).toBe(true);
      expect(spanLength(outward)).toBeCloseTo(spanLength(element), 6);
    }
  });

  it("puts a keyframe back on the source frame it named, across a trim", () => {
    // `trimStart` rebases the animation by how much *timeline* the consumed
    // source was worth. On a ramped clip that is the integral rather than a
    // division, and getting it wrong slides every curve against its footage.
    const rand = seededRandom(4321);
    for (let i = 0; i < 100; i++) {
      const element = rampedClip(rand, 2000);
      const keyframeLocal = spanLength(element) * (0.4 + rand() * 0.4);
      const named = sourceTimeAt(element, spanStart(element) + keyframeLocal);

      const applied = (rand() - 0.2) * 3000;
      const trimmed = trimStart(element, applied) as VideoElementType;
      const shift = spanStart(trimmed) - spanStart(element);
      const nowLocal = keyframeLocal - shift;

      expect(
        sourceTimeAt(trimmed, spanStart(trimmed) + nowLocal),
      ).toBeCloseTo(named, 6);
    }
  });
});

describe("the ripple under a continuous drag", () => {
  it("never reaches the clamp at timeline zero", () => {
    // `setClipSpeed`'s ripple writes `Math.max(0, clip.startTime + delta)`, and
    // a clamp that fired would deform the lane permanently: a drag that pushed
    // a clip against zero and then reversed would not bring it back, and a
    // graph drag emits hundreds of steps where the old `<select>` emitted one.
    //
    // It cannot fire, and the reason is worth pinning rather than guarding.
    // A trailing clip starts at or after the resized clip's old end, and the
    // clip can shrink by at most its own old length, so
    //
    //     start + delta >= (oldStart + oldLength) - oldLength = oldStart >= 0
    //
    // Swept rather than argued: 300 random ramps against a lane of trailing
    // clips packed as tightly as the ops allow.
    const rand = seededRandom(0x217d);
    for (let i = 0; i < 300; i++) {
      // Built one at a time and butted against the previous one's end. Placing
      // them at positions computed from separate `rampedClip` calls is what the
      // first draft did, and since each call draws its own ramp the positions
      // named clips that were never placed and the lane overlapped from the
      // start.
      const elements: Record<string, TimelineElement> = {};
      let cursor = 0;
      for (const id of ["a", "b", "c"]) {
        const clip = { ...rampedClip(rand, cursor), key: id };
        elements[id] = clip;
        cursor += spanLength(clip);
      }
      let document = doc(elements);

      // The most a clip can shrink by: every rate at the fast limit.
      document = setClipSpeedCurve(
        document,
        "a",
        [
          { t: 0, v: MAX_SPEED },
          { t: SOURCE_MS, v: MAX_SPEED - 1e-6 },
        ],
        { ripple: true },
      );

      for (const [id, clip] of Object.entries(document.elements)) {
        expect([id, clip.startTime >= 0]).toEqual([id, true]);
        // Not merely non-negative: nothing was clamped, so the lane still
        // reconstructs and a reversing drag puts it back.
        expect([id, Number.isFinite(clip.startTime)]).toEqual([id, true]);
      }
      const lane = clipsOnTrack(document, "v1");
      expect(lane.length).toBe(3);
      for (let j = 1; j < lane.length; j++) {
        expect(spanOf(lane[j][1]).start).toBeGreaterThanOrEqual(
          spanOf(lane[j - 1][1]).end - ADJACENCY_EPSILON_MS,
        );
      }
    }
  });
});

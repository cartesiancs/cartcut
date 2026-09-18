import { describe, it, expect } from "vitest";
import {
  formatSpeedOption,
  setClipSpeed,
  setClipSpeedCurve,
  coerceSpeed,
  isSpeedAdjustable,
  speedOptionsFor,
  MIN_SPEED,
  MAX_SPEED,
  SPEED_PRESETS,
} from "./speedOps";
import {
  ADJACENCY_EPSILON_MS,
  assertSpeedInvariant,
  assertTrimInvariant,
  spanOf,
  speedOf,
} from "./geometry";
import { withSpeedCurve } from "./clipEdit";
import {
  clipsOnTrack,
  createTrack,
  normalizeDocument,
  SCHEMA_VERSION,
  type TimelineDocument,
} from "./tracks";
import {
  videoElement,
  imageElement,
  audioElement,
  textElement,
  shapeElement,
  groupElement,
  effectElement,
  transitionElement,
} from "../renderer/testing";

function doc(elements: Record<string, any>, tracks = [["v1", "video"]] as any) {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: tracks.map(([id, kind]: any, index: number) =>
      createTrack(id, kind, index),
    ),
    elements,
  });
}

/** A ten-second video clip starting at `startTime`, on `v1`. */
function clip(startTime: number, durationMs = 10_000, over: any = {}) {
  return videoElement({
    trackId: "v1",
    startTime,
    duration: durationMs,
    sourceDuration: durationMs,
    trim: { startTime: 0, endTime: durationMs },
    speed: 1,
    ...over,
  });
}

describe("setClipSpeed", () => {
  it("halves the timeline span at 2x without touching the source window", () => {
    const before = doc({ a: clip(0) });
    const after = setClipSpeed(before, "a", 2);

    expect(spanOf(after.elements.a).length).toBe(5_000);
    // The source window is untouched: none of the footage is lost.
    expect(after.elements.a.duration).toBe(10_000);
    expect((after.elements.a as any).trim).toEqual({
      startTime: 0,
      endTime: 10_000,
    });
    expect(speedOf(after.elements.a)).toBe(2);
  });

  it("keeps the trim invariant, which is the one speed must not break", () => {
    const after = setClipSpeed(doc({ a: clip(0) }), "a", 0.5);
    expect(() => assertTrimInvariant(after.elements.a)).not.toThrow();
  });

  it("doubles the span at 0.5x", () => {
    const after = setClipSpeed(doc({ a: clip(0) }), "a", 0.5);
    expect(spanOf(after.elements.a).length).toBe(20_000);
  });

  // ------------------------------------------------------- decline by identity

  it("returns the input by identity for a missing clip", () => {
    const before = doc({ a: clip(0) });
    expect(setClipSpeed(before, "nope", 2)).toBe(before);
  });

  it("returns the input by identity for a clip with no source window", () => {
    const before = doc({ a: imageElement({ trackId: "v1" }) });
    expect(setClipSpeed(before, "a", 2)).toBe(before);
  });

  it("returns the input by identity when the speed is unchanged", () => {
    const before = doc({ a: clip(0) });
    expect(setClipSpeed(before, "a", 1)).toBe(before);
  });

  it("returns the input by identity for a speed out of range", () => {
    const before = doc({ a: clip(0) });
    expect(setClipSpeed(before, "a", MIN_SPEED / 2)).toBe(before);
    expect(setClipSpeed(before, "a", MAX_SPEED * 2)).toBe(before);
    expect(setClipSpeed(before, "a", 0)).toBe(before);
    expect(setClipSpeed(before, "a", -1)).toBe(before);
    expect(setClipSpeed(before, "a", Number.NaN)).toBe(before);
  });

  it("returns the input by identity when slowing down would overlap the next clip", () => {
    // `a` runs 0-10000, `b` starts right after. At 0.5x, `a` would run to
    // 20000 and swallow `b`.
    const before = doc({ a: clip(0), b: clip(10_000) });
    expect(setClipSpeed(before, "a", 0.5, { ripple: false })).toBe(before);
  });

  it("speeds a clip up without ripple when the gap it leaves is free", () => {
    const before = doc({ a: clip(0), b: clip(10_000) });
    const after = setClipSpeed(before, "a", 2, { ripple: false });

    expect(after).not.toBe(before);
    expect(spanOf(after.elements.a).length).toBe(5_000);
    // Without ripple the later clip stays exactly where it was.
    expect(after.elements.b.startTime).toBe(10_000);
  });

  // -------------------------------------------------------------------- ripple

  it("pushes later clips on the same track along when slowing down", () => {
    const before = doc({ a: clip(0), b: clip(10_000) });
    const after = setClipSpeed(before, "a", 0.5, { ripple: true });

    expect(spanOf(after.elements.a).length).toBe(20_000);
    // `b` moved by exactly what `a` grew.
    expect(after.elements.b.startTime).toBe(20_000);
  });

  it("closes the gap when speeding up", () => {
    const before = doc({ a: clip(0), b: clip(10_000) });
    const after = setClipSpeed(before, "a", 2, { ripple: true });

    expect(after.elements.b.startTime).toBe(5_000);
  });

  it("is lane-local: a clip on another track does not move", () => {
    const before = doc(
      { a: clip(0), other: clip(10_000, 10_000, { trackId: "v2" }) },
      [
        ["v1", "video"],
        ["v2", "video"],
      ],
    );
    const after = setClipSpeed(before, "a", 0.5, { ripple: true });

    expect(after.elements.other.startTime).toBe(10_000);
  });

  it("leaves earlier clips alone", () => {
    const before = doc({ early: clip(0), a: clip(10_000) });
    const after = setClipSpeed(before, "a", 0.5, { ripple: true });

    expect(after.elements.early.startTime).toBe(0);
    expect(after.elements.a.startTime).toBe(10_000);
  });

  it("works on audio, which carries a source window too", () => {
    const before = doc(
      {
        a: audioElement({
          trackId: "a1",
          startTime: 0,
          duration: 8_000,
          sourceDuration: 8_000,
          trim: { startTime: 0, endTime: 8_000 },
          speed: 1,
        }),
      },
      [["a1", "audio"]],
    );
    const after = setClipSpeed(before, "a", 2);
    expect(spanOf(after.elements.a).length).toBe(4_000);
  });

  it("can be set back to 1", () => {
    const fast = setClipSpeed(doc({ a: clip(0) }), "a", 2);
    const back = setClipSpeed(fast, "a", 1);

    expect(speedOf(back.elements.a)).toBe(1);
    expect(spanOf(back.elements.a).length).toBe(10_000);
  });

  // ------------------------------------------------- ripple cannot ever collide

  /** Whether any two clips on `trackId` overlap. */
  function hasOverlap(document: TimelineDocument, trackId: string): boolean {
    const spans = clipsOnTrack(document, trackId)
      .map(([, element]) => spanOf(element))
      .sort((left, right) => left.start - right.start);

    return spans.some(
      (span, index) =>
        index > 0 && span.start < spans[index - 1].end - ADJACENCY_EPSILON_MS,
    );
  }

  /**
   * The property the speed control's UI rests on.
   *
   * A ripple shifts every later clip on the lane by exactly the amount this one
   * grew or shrank, so the gap in front of them changes by the same amount it
   * did — there is nowhere for a collision to come from. That is what lets the
   * panel offer every preset unconditionally, with no disabled options, no
   * "no room here" hint and no ripple toggle to explain them.
   *
   * If this ever goes red, the panel needs all three back.
   */
  it("never declines for a collision, at any preset, with ripple on", () => {
    // `a` is boxed in: a clip ends exactly where it starts, and another starts
    // exactly where it ends. Every preset moves at least one of its edges.
    const before = doc({
      early: clip(0),
      a: clip(10_000),
      late: clip(20_000),
    });

    for (const speed of SPEED_PRESETS) {
      if (speed === speedOf(before.elements.a)) {
        continue;
      }

      const after = setClipSpeed(before, "a", speed, { ripple: true });

      expect(after, `speed ${speed} was declined`).not.toBe(before);
      expect(speedOf(after.elements.a), `speed ${speed}`).toBe(speed);
      expect(hasOverlap(after, "v1"), `speed ${speed} overlapped`).toBe(false);
      // The clip in front is never touched — ripple is a one-way push.
      expect(after.elements.early.startTime).toBe(0);
    }
  });
});

// ---------------------------------------------------------------- the UI split

describe("isSpeedAdjustable", () => {
  it("accepts the two types that carry a source window", () => {
    expect(isSpeedAdjustable(videoElement({}))).toBe(true);
    expect(isSpeedAdjustable(audioElement({}))).toBe(true);
  });

  /**
   * The case that pins this to `isDynamicElement` rather than to a hand-written
   * filetype list. `utils/element.ts` counts `mp4`/`mov`/`mp3` as dynamic, so a
   * copied list would disagree with `setClipSpeed`'s own guard — and disagree
   * silently, in the direction where the panel hides a control that would have
   * worked.
   */
  it("accepts the legacy dynamic filetype aliases", () => {
    for (const filetype of ["mp4", "mov", "mp3"]) {
      expect(
        isSpeedAdjustable(videoElement({ filetype } as any)),
        filetype,
      ).toBe(true);
    }
  });

  it("rejects every type that has no playback rate", () => {
    expect(isSpeedAdjustable(imageElement({}))).toBe(false);
    expect(isSpeedAdjustable(textElement({}))).toBe(false);
    expect(isSpeedAdjustable(shapeElement({}))).toBe(false);
    expect(isSpeedAdjustable(groupElement({}))).toBe(false);
    expect(isSpeedAdjustable(effectElement({}))).toBe(false);
    expect(isSpeedAdjustable(transitionElement({}))).toBe(false);
  });

  it("tolerates a missing element, so the panel can ask before it has one", () => {
    expect(isSpeedAdjustable(null)).toBe(false);
    expect(isSpeedAdjustable(undefined)).toBe(false);
  });
});

describe("coerceSpeed", () => {
  it("passes an in-range number through", () => {
    expect(coerceSpeed(2)).toBe(2);
    expect(coerceSpeed(0.5)).toBe(0.5);
  });

  it("reads a numeric string, which is what a select gives back", () => {
    expect(coerceSpeed("2")).toBe(2);
    expect(coerceSpeed("0.25")).toBe(0.25);
  });

  it("accepts both ends of the range", () => {
    expect(coerceSpeed(MIN_SPEED)).toBe(MIN_SPEED);
    expect(coerceSpeed(MAX_SPEED)).toBe(MAX_SPEED);
  });

  /**
   * Unlike `coerceFps`, which rounds. A frame rate of 59.99 is a float artefact
   * of a rate that has to be a whole number of frames; 1.75x is a speed someone
   * meant, and rounding it to 2x would change the edit under them.
   */
  it("does not round", () => {
    expect(coerceSpeed(1.75)).toBe(1.75);
    expect(coerceSpeed(0.333)).toBe(0.333);
  });

  it("refuses anything out of range or unusable", () => {
    expect(coerceSpeed(MIN_SPEED - 0.01)).toBeNull();
    expect(coerceSpeed(MAX_SPEED + 0.01)).toBeNull();
    expect(coerceSpeed(0)).toBeNull();
    expect(coerceSpeed(-1)).toBeNull();
    expect(coerceSpeed(Number.NaN)).toBeNull();
    expect(coerceSpeed(Number.POSITIVE_INFINITY)).toBeNull();
    expect(coerceSpeed("")).toBeNull();
    expect(coerceSpeed("fast")).toBeNull();
    expect(coerceSpeed(true)).toBeNull();
    expect(coerceSpeed(null)).toBeNull();
    expect(coerceSpeed(undefined)).toBeNull();
    expect(coerceSpeed({})).toBeNull();
  });
});

describe("SPEED_PRESETS", () => {
  it("runs the full supported range, in order, through 1", () => {
    expect(SPEED_PRESETS[0]).toBe(MIN_SPEED);
    expect(SPEED_PRESETS[SPEED_PRESETS.length - 1]).toBe(MAX_SPEED);
    expect(SPEED_PRESETS).toContain(1);
    expect([...SPEED_PRESETS]).toEqual(
      [...SPEED_PRESETS].sort((left, right) => left - right),
    );
  });

  it("offers nothing the write guard would refuse", () => {
    for (const speed of SPEED_PRESETS) {
      expect(coerceSpeed(speed), String(speed)).toBe(speed);
    }
  });
});

describe("speedOptionsFor", () => {
  it("is the presets when the clip sits on one", () => {
    expect(speedOptionsFor(2)).toEqual([...SPEED_PRESETS]);
    expect(speedOptionsFor(1)).toEqual([...SPEED_PRESETS]);
  });

  /**
   * `set_clip_speed` takes any rate in range, so a clip can arrive at 1.7x from
   * the agent. Dropping it would make the select show 0.25x — its first option —
   * for a clip running at 1.7x, and the next thing the user clicked would
   * silently be a second edit rather than the one they meant.
   */
  it("splices an off-preset rate into sorted position", () => {
    expect(speedOptionsFor(1.7)).toEqual([0.25, 0.5, 1, 1.5, 1.7, 2, 4]);
    expect(speedOptionsFor(0.3)).toEqual([0.25, 0.3, 0.5, 1, 1.5, 2, 4]);
  });

  it("never repeats a rate", () => {
    for (const current of [...SPEED_PRESETS, 1.7, 3.9]) {
      const options = speedOptionsFor(current);
      expect(new Set(options).size, String(current)).toBe(options.length);
      expect(options, String(current)).toContain(current);
    }
  });

  it("falls back to real time for a rate that makes no sense", () => {
    expect(speedOptionsFor(Number.NaN)).toEqual([...SPEED_PRESETS]);
    expect(speedOptionsFor(0)).toEqual([...SPEED_PRESETS]);
  });
});

describe("the menu a ramped clip offers", () => {
  it("would splice the ramp's mean into the list, which is why the panel does not ask", () => {
    // `speedOptionsFor` is right for a clip the agent set to an off-preset
    // rate and wrong for a ramp's derived mean, which is an arbitrary float
    // nobody chose. Found by running the app: a slow-middle ramp rendered a
    // menu entry reading "0.4009824491765815x".
    const mean = 10_000 / 24_938.747370452314;
    expect(speedOptionsFor(mean)).toContain(mean);
    expect(SPEED_PRESETS).not.toContain(mean as never);
  });
});

describe("setClipSpeedCurve", () => {
  const RAMP = [
    { t: 0, v: 1 },
    { t: 10_000, v: 2 },
  ];

  function ramped(startTime = 0) {
    return doc({ a: withSpeedCurve(clip(startTime), RAMP) });
  }

  it("resizes the clip to what the ramp takes to play its window", () => {
    const after = setClipSpeedCurve(doc({ a: clip(0) }), "a", RAMP);
    const element = after.elements.a;
    // 10s of source ramped 1x to 2x takes 10000 * ln(2) of timeline.
    expect(spanOf(element).length).toBeCloseTo(10_000 * Math.LN2, 3);
    expect(element.duration).toBe(10_000);
    expect(() => assertSpeedInvariant(element)).not.toThrow();
  });

  it("returns the input by identity when the ramp is already exactly this", () => {
    // The convention every op here follows: re-picking the preset a clip is
    // already on, or a drag step that has not moved, must cost no undo entry.
    const before = ramped();
    expect(setClipSpeedCurve(before, "a", RAMP)).toBe(before);
    // A fresh array of equal points is the same ramp, and is what a preset
    // rebuild and a JSON round trip both hand back.
    expect(setClipSpeedCurve(before, "a", RAMP.map((p) => ({ ...p })))).toBe(
      before,
    );
  });

  it("returns the input by identity for the declines it shares with setClipSpeed", () => {
    const before = ramped();
    expect(setClipSpeedCurve(before, "missing", RAMP)).toBe(before);

    // An image has no source window and so no rate to ramp.
    const still = doc({ i: imageElement({ trackId: "v1" }) });
    expect(setClipSpeedCurve(still, "i", RAMP)).toBe(still);

    // Removing a ramp that is not there, and a flat curve, are both no-ops.
    const plain = doc({ a: clip(0) });
    expect(setClipSpeedCurve(plain, "a", null)).toBe(plain);
    expect(
      setClipSpeedCurve(plain, "a", [
        { t: 0, v: 1 },
        { t: 1000, v: 1 },
      ]),
    ).toBe(plain);
  });

  it("takes the ramp off and leaves the clip where the mean had it", () => {
    const before = ramped();
    const mean = speedOf(before.elements.a);
    const after = setClipSpeedCurve(before, "a", null);
    expect((after.elements.a as any).speedCurve).toBeUndefined();
    expect(speedOf(after.elements.a)).toBe(mean);
    expect(spanOf(after.elements.a).length).toBeCloseTo(
      spanOf(before.elements.a).length,
      9,
    );
  });

  it("pushes later clips along, the same ripple setClipSpeed uses", () => {
    const before = doc({ a: clip(0), b: clip(10_000) });
    const after = setClipSpeedCurve(before, "a", RAMP, { ripple: true });
    const grew = spanOf(after.elements.a).length - 10_000;
    expect(after.elements.b.startTime).toBeCloseTo(10_000 + grew, 6);
  });

  it("never declines for a collision with ripple on, at any shape", () => {
    // The property the option panel leans on, repeated for the curve: every
    // ramp the graph can draw has to be reachable with no "no room" state.
    const shapes = [
      [
        { t: 0, v: MIN_SPEED },
        { t: 10_000, v: MIN_SPEED + 0.01 },
      ],
      [
        { t: 0, v: MAX_SPEED },
        { t: 10_000, v: MAX_SPEED - 0.01 },
      ],
      [
        { t: 0, v: MAX_SPEED },
        { t: 5000, v: MIN_SPEED },
        { t: 10_000, v: MAX_SPEED },
      ],
    ];
    for (const shape of shapes) {
      const before = doc({ a: clip(0), b: clip(10_000), c: clip(20_000) });
      const after = setClipSpeedCurve(before, "a", shape, { ripple: true });
      expect(after).not.toBe(before);
      const lane = clipsOnTrack(after, "v1");
      for (let i = 1; i < lane.length; i++) {
        expect(spanOf(lane[i][1]).start).toBeGreaterThanOrEqual(
          spanOf(lane[i - 1][1]).end - ADJACENCY_EPSILON_MS,
        );
      }
    }
  });
});

describe("formatSpeedOption", () => {
  it("leaves every preset reading exactly as it did", () => {
    expect(SPEED_PRESETS.map(formatSpeedOption)).toEqual([
      "0.25",
      "0.5",
      "1",
      "1.5",
      "2",
      "4",
    ]);
  });

  it("makes a flattened ramp's mean readable", () => {
    // Found in the running app: turning the ramp toggle off leaves the clip at
    // the ramp's mean, and the menu rendered it as "0.4009824491765815x".
    expect(formatSpeedOption(10_000 / 24_938.747370452314)).toBe("0.4");
    expect(formatSpeedOption(1.7333333)).toBe("1.73");
  });

  it("never rounds a rate out of the range the menu may offer", () => {
    expect(Number(formatSpeedOption(MIN_SPEED))).toBeGreaterThanOrEqual(
      MIN_SPEED,
    );
    expect(Number(formatSpeedOption(MAX_SPEED))).toBeLessThanOrEqual(MAX_SPEED);
  });

  it("falls back to real time for a rate that makes no sense", () => {
    expect(formatSpeedOption(Number.NaN)).toBe("1");
  });
});

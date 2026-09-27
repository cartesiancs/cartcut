/**
 * The whole pipeline, checked where it actually shows: on the drawn box.
 *
 * Every other suite here tests one stage. This one runs an input track through
 * `planZoom` -> `runCamera` -> `zoomKeyframeWrites`, applies the writes through the
 * **real** keyframe machinery that `set_keyframes` uses, and then asks
 * `localSampleAt`, the function the renderer itself calls, where the clip is at
 * every frame.
 *
 * The reference it is checked against is `referencePose`, which reads the segment
 * list directly and shares no code with the writing, the baking or the sampling. So
 * agreement is evidence rather than a tautology, which is the habit CLAUDE.md asks
 * for: the LUT and audio suites do the same thing by running ffmpeg against our own
 * sampler.
 */
import { describe, it, expect } from "vitest";
import {
  prepareWrites,
  applyWrites,
} from "../agent/commands/keyframeWrites";
import { emptyAnimation } from "../animation/keyframes";
import { localSampleAt } from "../timeline/transform";
import {
  SCHEMA_VERSION,
  createTrack,
  type TimelineDocument,
} from "../timeline/tracks";
import { clampAim, recordBox, recordFit, type Size } from "./recordFit";
import { referencePose, runCamera } from "./zoomCamera";
import { planZoom, type CursorSample, type PointerMark } from "./zoomPlan";
import { restingBox, zoomKeyframeWrites } from "./zoomKeyframes";

const FRAME: Size = { width: 1920, height: 1080 };
const LAPTOP: Size = { width: 3024, height: 1964 };
const ULTRAWIDE: Size = { width: 3440, height: 1440 };
const SPAN = 9000;

/** A clip the size of the capture, as `buildVideo` would have placed it. */
function document(capture: Size): TimelineDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements: {
      clip: {
        filetype: "video",
        startTime: 0,
        duration: SPAN,
        location: { x: 0, y: 0 },
        width: capture.width,
        height: capture.height,
        opacity: 100,
        rotation: 0,
        trim: { startTime: 0, endTime: SPAN },
        sourceDuration: SPAN,
        speed: 1,
        animation: emptyAnimation("video"),
      } as any,
    },
  };
}

/** Apply the writes the way the agent command does, in one pass. */
function write(doc: TimelineDocument, writes: ReturnType<typeof zoomKeyframeWrites>) {
  const prepared = prepareWrites(
    doc,
    writes,
    (id) => {
      const element = doc.elements[id];
      if (element == null) throw new Error(`no element ${id}`);
      return element;
    },
    (index) => `writes[${index}]`,
  );
  return applyWrites(doc, prepared, 60);
}

function pipeline(
  capture: Size,
  cursor: CursorSample[],
  pointer: PointerMark[],
  strength: "on" = "on",
) {
  const fit = recordFit(capture, FRAME);
  const segments = planZoom({ cursor, pointer }, capture, strength, SPAN);
  const instants = runCamera(segments, cursor, capture, fit, FRAME, SPAN);
  const writes = zoomKeyframeWrites("clip", instants, fit, FRAME, 0, SPAN);
  const doc = write(document(capture), writes);
  return { fit, segments, instants, writes, doc };
}

/** Every frame of the clip at 60fps, plus the instants themselves. */
function everyFrame(instants: { t: number }[]): number[] {
  const list = new Set<number>();
  for (let t = 0; t <= SPAN; t += 1000 / 60) {
    list.add(Math.round(t * 1000) / 1000);
  }
  for (const instant of instants) {
    list.add(instant.t);
  }
  return [...list].sort((a, b) => a - b);
}

describe("a recording's zoom, end to end", () => {
  const cursor = [
    ...(() => {
      const samples: CursorSample[] = [];
      for (let t = 0; t <= 6000; t += 33) {
        samples.push({ t, x: 2200, y: 1500 });
      }
      return samples;
    })(),
  ];
  const pointer: PointerMark[] = [{ t: 2000, x: 2200, y: 1500, kind: "down" }];

  it("writes both tracks with identical instants", () => {
    const { writes } = pipeline(LAPTOP, cursor, pointer);
    expect(writes.length).toBe(2);
    const [size, position] = writes;
    expect(size.property).toBe("size");
    expect(position.property).toBe("position");
    expect(size.keyframes.map((k) => k.atMs)).toEqual(
      position.keyframes.map((k) => k.atMs),
    );
    expect(size.keyframes.map((k) => k.easing)).toEqual(
      position.keyframes.map((k) => k.easing),
    );
  });

  it("arms both tracks and leaves no other property animated", () => {
    const { doc } = pipeline(LAPTOP, cursor, pointer);
    const animation = (doc.elements.clip as any).animation;
    expect(animation.size.isActivate).toBe(true);
    expect(animation.position.isActivate).toBe(true);
    expect(animation.scale.isActivate).toBe(false);
    expect(animation.rotation.isActivate).toBe(false);
    expect(animation.opacity.isActivate).toBe(false);
  });

  /** The largest gap between the drawn box and the plan's, over some instants. */
  function gap(
    doc: TimelineDocument,
    segments: ReturnType<typeof planZoom>,
    fit: ReturnType<typeof recordFit>,
    times: number[],
  ): number {
    let worst = 0;
    for (const t of times) {
      const sample = localSampleAt(doc.elements.clip, t);
      const pose = referencePose(segments, fit, FRAME, t);
      const expected = recordBox(fit, FRAME, pose.z, pose.u, pose.v);
      worst = Math.max(
        worst,
        Math.abs(sample.width - expected.width),
        Math.abs(sample.height - expected.height),
        Math.abs(sample.x - expected.x),
        Math.abs(sample.y - expected.y),
      );
    }
    return worst;
  }

  // The check that matters. Two implementations, no shared code: the reference
  // reads the segment list, the measurement goes through the write, the bake and
  // `localSampleAt`, which is the function the renderer itself calls.
  it("draws where the plan says, at every instant and throughout every hold", () => {
    for (const capture of [LAPTOP, ULTRAWIDE]) {
      const { fit, segments, instants, doc } = pipeline(capture, cursor, pointer);
      expect(segments.length).toBeGreaterThan(0);

      const times = instants.map((instant) => instant.t);
      for (const segment of segments) {
        for (let t = segment.inEnd; t <= segment.outStart; t += 1000 / 60) {
          times.push(t);
        }
      }

      // Within a pixel of a 1920-wide frame. Not zero, because `sampleBaked` snaps
      // to its 60Hz grid rather than interpolating between samples.
      expect(gap(doc, segments, fit, times)).toBeLessThan(1);
    }
  });

  it("would notice if the two disagreed", () => {
    // Proving the harness measures something: reading the pose from a plan built
    // from a different click has to blow the tolerance above.
    const { fit, instants, doc } = pipeline(LAPTOP, cursor, pointer);
    const other = planZoom(
      { cursor: [], pointer: [{ t: 5000, x: 200, y: 200, kind: "down" }] },
      LAPTOP,
      "on",
      SPAN,
    );

    expect(gap(doc, other, fit, instants.map((instant) => instant.t))).toBeGreaterThan(10);
  });

  // What the eases guarantee instead, and the reason they need guarantee nothing
  // stronger: between two instants the clip draws the linear blend of two boxes, so
  // a zoom that is monotone at the instants is monotone everywhere between them.
  it("zooms in and back out without reversing on the way", () => {
    const { segments, doc } = pipeline(LAPTOP, cursor, pointer);
    const [segment] = segments;

    const widthAt = (t: number) => localSampleAt(doc.elements.clip, t).width;

    let previous = widthAt(segment.inStart);
    for (let t = segment.inStart; t <= segment.inEnd; t += 1000 / 60) {
      const width = widthAt(t);
      expect(width).toBeGreaterThanOrEqual(previous - 1e-6);
      previous = width;
    }

    previous = widthAt(segment.outStart);
    for (let t = segment.outStart; t <= segment.outEnd; t += 1000 / 60) {
      const width = widthAt(t);
      expect(width).toBeLessThanOrEqual(previous + 1e-6);
      previous = width;
    }
  });

  // The user's explicit requirement, and a good last frame besides.
  it("ends on the whole screen", () => {
    const { fit, doc } = pipeline(LAPTOP, cursor, pointer);
    const resting = restingBox(fit, FRAME);
    const sample = localSampleAt(doc.elements.clip, SPAN);

    expect(sample.width).toBeCloseTo(resting.width, 3);
    expect(sample.height).toBeCloseTo(resting.height, 3);
    expect(sample.x).toBeCloseTo(resting.x, 3);
    expect(sample.y).toBeCloseTo(resting.y, 3);
  });

  it("starts on the whole screen too", () => {
    const { fit, doc } = pipeline(LAPTOP, cursor, pointer);
    const resting = restingBox(fit, FRAME);
    const sample = localSampleAt(doc.elements.clip, 0);
    expect(sample.width).toBeCloseTo(resting.width, 3);
    expect(sample.x).toBeCloseTo(resting.x, 3);
  });

  it("never draws background where the picture should be covering", () => {
    // The same property as `zoomCamera`'s, but measured through the bake and the
    // sampler rather than through the instants, so a bug anywhere in the write path
    // shows up here too.
    for (const capture of [LAPTOP, ULTRAWIDE]) {
      const corner: PointerMark[] = [
        { t: 2000, x: capture.width * 0.95, y: capture.height * 0.95, kind: "down" },
      ];
      const { instants, doc } = pipeline(capture, [], corner);

      for (const t of everyFrame(instants)) {
        const sample = localSampleAt(doc.elements.clip, t);
        if (sample.width < FRAME.width - 0.5 || sample.height < FRAME.height - 0.5) {
          continue; // Legitimately at rest, inset on the background.
        }
        expect(sample.x).toBeLessThanOrEqual(1.5);
        expect(sample.y).toBeLessThanOrEqual(1.5);
        expect(sample.x + sample.width).toBeGreaterThanOrEqual(FRAME.width - 1.5);
        expect(sample.y + sample.height).toBeGreaterThanOrEqual(FRAME.height - 1.5);
      }
    }
  });

  it("holds the aimed-at point still through a hold", () => {
    // The property `zoomFocus.test.ts` pins for a hand-built punch-in, here for a
    // generated one: while the aim is constant, `x` is affine in `w`, so the point
    // does not drift between the anchors.
    const { fit, segments, doc } = pipeline(LAPTOP, cursor, pointer);
    const [segment] = segments;
    const aim = clampAim(fit, FRAME, segment.zoom, segment.u, segment.v);

    const seen: { x: number; y: number }[] = [];
    for (let t = segment.inEnd; t <= segment.outStart; t += 1000 / 60) {
      const sample = localSampleAt(doc.elements.clip, t);
      seen.push({
        x: sample.x + aim.u * sample.width,
        y: sample.y + aim.v * sample.height,
      });
    }

    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
    expect(spread(seen.map((p) => p.x))).toBeLessThan(1.5);
    expect(spread(seen.map((p) => p.y))).toBeLessThan(1.5);
  });

  it("writes nothing for a plan with nothing in it", () => {
    const fit = recordFit(LAPTOP, FRAME);
    const instants = runCamera([], [], LAPTOP, fit, FRAME, SPAN);
    // Two resting instants is a static pose, not an animation, and the caller sets
    // the static box instead.
    expect(zoomKeyframeWrites("clip", instants, fit, FRAME, 0, SPAN).length).toBe(2);
    expect(zoomKeyframeWrites("clip", [], fit, FRAME, 0, SPAN)).toEqual([]);
  });

  // The regression this was written against, found by recording for real: main's
  // media clock said 19.2s and the muxed container said 18.5s, the release landed
  // in the 700ms between them, and the clip ended still fully zoomed at 2x.
  it("ends on the whole screen even when the plan was built for a longer clip", () => {
    const fit = recordFit(LAPTOP, FRAME);
    // Placed so the move's own release lands in the 800ms the two clocks disagree
    // by: inside the plan, past the end of the clip.
    const segments = planZoom(
      { cursor: [], pointer: [{ t: 7300, x: 2800, y: 1800, kind: "down" }] },
      LAPTOP,
      "on",
      SPAN + 800,
    );
    const instants = runCamera(segments, [], LAPTOP, fit, FRAME, SPAN + 800);

    // The release really does fall past the clip, or this asserts nothing.
    expect(segments.length).toBe(1);
    expect(segments[0].outEnd).toBeGreaterThan(SPAN);
    expect(instants.some((i) => i.t > SPAN)).toBe(true);

    const writes = zoomKeyframeWrites("clip", instants, fit, FRAME, 0, SPAN);
    const doc = write(document(LAPTOP), writes);

    const resting = restingBox(fit, FRAME);
    const sample = localSampleAt(doc.elements.clip, SPAN);
    expect(sample.width).toBeCloseTo(resting.width, 3);
    expect(sample.height).toBeCloseTo(resting.height, 3);
    expect(sample.x).toBeCloseTo(resting.x, 3);
  });

  it("drops an instant past the end of the clip rather than throwing", () => {
    // `localTime` refuses a time outside the clip and never clamps, so a plan built
    // against a duration the clip does not have has to be trimmed here.
    const fit = recordFit(LAPTOP, FRAME);
    const instants = runCamera([], [], LAPTOP, fit, FRAME, SPAN * 2);
    const writes = zoomKeyframeWrites("clip", instants, fit, FRAME, 0, SPAN);
    for (const write of writes) {
      for (const keyframe of write.keyframes) {
        expect(keyframe.atMs).toBeLessThanOrEqual(SPAN);
      }
    }
  });
});

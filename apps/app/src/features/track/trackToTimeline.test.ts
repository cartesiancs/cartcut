import { describe, expect, it } from "vitest";
import type { Timeline } from "../../@types/timeline";
import { bakeTrack } from "../animation/keyframes";
import { frameToMs } from "../timeline/frames";
import { keys, textElement, videoElement } from "../renderer/testing";
import {
  canvasToFramePoint,
  toDisplayedPath,
  toProjectPath,
  trackedEndMs,
} from "./trackToTimeline";
import type { TrackSample } from "./tracker";
import { nextFrameGap, SEEK_ARRIVALS_NEEDED, seekedFrameMs } from "./frameSource";

const FRAME = { frameWidth: 200, frameHeight: 100 };

function sample(sourceMs: number, x: number, y: number): TrackSample {
  return { sourceMs, x, y, confidence: 1 };
}

function elements(over: Record<string, any> = {}): Timeline {
  return { clip: videoElement(), ...over } as unknown as Timeline;
}

describe("toProjectPath", () => {
  it("maps the centre of the frame to the centre of the clip's box", () => {
    const path = toProjectPath([sample(0, 100, 50)], {
      elements: elements(),
      clipId: "clip",
      ...FRAME,
      fps: 60,
    });

    // 100×100 box, so half of each side.
    expect(path).toEqual([{ tMs: 0, x: 50, y: 50 }]);
  });

  it("carries the clip's own placement", () => {
    const path = toProjectPath([sample(0, 100, 50)], {
      elements: elements({
        clip: videoElement({ location: { x: 30, y: 40 } }),
      }),
      clipId: "clip",
      ...FRAME,
      fps: 60,
    });

    expect(path).toEqual([{ tMs: 0, x: 80, y: 90 }]);
  });

  it("is independent of the working resolution", () => {
    // The normalised step in the middle is what lets `frameSource.ts` decode at
    // whatever size is cheap: dividing by the size it decoded at cancels it.
    const half = toProjectPath([sample(0, 50, 25)], {
      elements: elements(),
      clipId: "clip",
      frameWidth: 100,
      frameHeight: 50,
      fps: 60,
    });

    expect(half).toEqual([{ tMs: 0, x: 50, y: 50 }]);
  });

  it("reads the box through the size track, not the static field", () => {
    // A clip whose `size` is animated has a box that changes under the cursor.
    // Reading `element.width` here would place the point correctly at t=0 and
    // progressively wrongly after it.
    const clip = videoElement({
      startTime: 0,
      duration: 4000,
      animation: {
        ...videoElement().animation,
        size: {
          isActivate: true,
          x: keys([0, 100], [1000, 200]),
          y: keys([0, 100], [1000, 100]),
          ax: bakeTrack(keys([0, 100], [1000, 200])),
          ay: bakeTrack(keys([0, 100], [1000, 100])),
        },
      },
    });

    const path = toProjectPath([sample(1000, 200, 50)], {
      elements: elements({ clip }),
      clipId: "clip",
      ...FRAME,
      fps: 60,
    });

    // Right edge of the frame, and at t=1000 the box is 200 wide.
    expect(path[0].x).toBeCloseTo(200, 4);
  });

  it("converts source time through the trim and the speed", () => {
    const clip = videoElement({
      startTime: 500,
      duration: 4000,
      speed: 2,
      trim: { startTime: 1000, endTime: 5000 },
    });

    const path = toProjectPath([sample(2000, 100, 50)], {
      elements: elements({ clip }),
      clipId: "clip",
      ...FRAME,
      fps: 60,
    });

    // 500 + (2000 − 1000) / 2
    expect(path[0].tMs).toBe(1000);
  });

  it("snaps to the frame grid", () => {
    const path = toProjectPath([sample(17, 100, 50)], {
      elements: elements(),
      clipId: "clip",
      ...FRAME,
      fps: 30,
    });

    // 33.33ms per frame at 30fps; 17ms is nearest the frame at 33.33.
    expect(path[0].tMs).toBeCloseTo(1000 / 30, 4);
  });

  it("drops samples that land outside the clip's span", () => {
    const path = toProjectPath(
      [sample(0, 100, 50), sample(9000, 100, 50)],
      { elements: elements(), clipId: "clip", ...FRAME, fps: 60 },
    );

    expect(path).toHaveLength(1);
  });

  it("declines on an element that has no source time", () => {
    expect(
      toProjectPath([sample(0, 1, 1)], {
        elements: { clip: textElement() } as unknown as Timeline,
        clipId: "clip",
        ...FRAME,
        fps: 60,
      }),
    ).toEqual([]);
  });

  it("declines on a missing clip or a degenerate frame", () => {
    const base = { elements: elements(), clipId: "clip", fps: 60 };

    expect(
      toProjectPath([sample(0, 1, 1)], { ...base, clipId: "nope", ...FRAME }),
    ).toEqual([]);
    expect(
      toProjectPath([sample(0, 1, 1)], {
        ...base,
        frameWidth: 0,
        frameHeight: 100,
      }),
    ).toEqual([]);
  });
});

describe("canvasToFramePoint", () => {
  it("scales a click on the panel's canvas into the decoded frame", () => {
    expect(
      canvasToFramePoint(
        { x: 240, y: 90 },
        { width: 480, height: 270 },
        { width: 1920, height: 1080 },
      ),
    ).toEqual({ x: 960, y: 360 });
  });

  it("answers the origin rather than dividing by zero", () => {
    expect(
      canvasToFramePoint(
        { x: 10, y: 10 },
        { width: 0, height: 0 },
        { width: 100, height: 100 },
      ),
    ).toEqual({ x: 0, y: 0 });
  });
});

describe("trackedEndMs", () => {
  // On the timeline from 3000 to 7000, so a clip placed late is the default.
  const clip = videoElement({ startTime: 3000, duration: 4000 });
  const at = (...times: number[]) => times.map((tMs) => ({ tMs, x: 0, y: 0 }));
  /** A sample on every one of `count` frames of `stepMs`, from `fromMs`. */
  const frames = (fromMs: number, stepMs: number, count: number) =>
    at(...Array.from({ length: count }, (_, i) => fromMs + i * stepMs));

  it("ends where the last sample's frame stops", () => {
    expect(trackedEndMs(frames(3000, 20, 51), clip, 50)).toBeCloseTo(4020, 6);
  });

  it("holds slower footage's last frame for as long as it is shown", () => {
    // 30fps footage in a 60fps project: each picture is up for two project
    // frames, and a bar one project frame past it would stop half way.
    const end = trackedEndMs(frames(3000, 1000 / 30, 31), clip, 60) as number;

    expect(end).toBeCloseTo(4000 + 1000 / 30, 6);
  });

  it("ends exactly on the clip's end when the whole clip was tracked", () => {
    expect(trackedEndMs(frames(3000, 1000 / 30, 120), clip, 60)).toBe(7000);
    expect(trackedEndMs(frames(3000, 20, 200), clip, 50)).toBe(7000);
  });

  it("lands on the grid rather than a rounding error short of it", () => {
    // The last two frames of 30fps footage ending at 13000 in a 60fps
    // project, snapped as `toProjectPath` snaps them. Added up they come to
    // 2e-12 short of the clip's end, a bar that stops before the clip does.
    const late = videoElement({ startTime: 7000, duration: 6000 });
    const path = at(frameToMs(776, 60), frameToMs(778, 60));

    expect(trackedEndMs(path, late, 60)).toBe(13000);
  });

  it("never runs past the clip, whose last frame may be short", () => {
    const offGrid = videoElement({ startTime: 3000, duration: 3990 });

    expect(trackedEndMs(frames(6940, 20, 3), offGrid, 50)).toBe(6990);
  });

  it("gives a lone sample one project frame", () => {
    expect(trackedEndMs(at(5000), clip, 50)).toBe(5020);
    expect(trackedEndMs(at(5000, 5000), clip, 50)).toBe(5020);
  });

  it("reads the latest samples, not the last in the list", () => {
    expect(trackedEndMs(at(5000, 3000, 4980), clip, 50)).toBe(5020);
  });

  it("answers null for a path with nothing in it", () => {
    expect(trackedEndMs([], clip, 50)).toBeNull();
    expect(trackedEndMs(at(NaN), clip, 50)).toBeNull();
  });
});


describe("toDisplayedPath", () => {
  /**
   * The feature's position in source frame `j`, in working pixels of the
   * 200x100 frame. A curve rather than a line, so a held value, a value
   * interpolated between neighbours and the true one all differ.
   */
  const truth = (j: number) => ({
    x: 100 + 60 * Math.sin(j * 0.21),
    y: 50 + 30 * Math.cos(j * 0.17),
  });
  /** `truth`'s largest second derivative per frame², each lane, project px. */
  const BEND = { x: (60 * 0.21 * 0.21) / 2, y: 30 * 0.17 * 0.17 };

  /** The default 100x100 box at the origin halves x and keeps y. */
  const toProject = (p: { x: number; y: number }) => ({ x: p.x / 2, y: p.y });

  type Harvested = { samples: TrackSample[]; arrivals: number[] };

  /**
   * What the panel's harvest hands the tracker, with a perfect tracker.
   *
   * The rule is copied from `frameSource.ts#harvestByPlaying` as data rather
   * than imported, so a change there has to be made here on purpose: the seed
   * is reported at the instant asked for, carrying the frame a seek there
   * shows; then every presented frame at least one stride (less half a
   * millisecond) past the last one kept.
   */
  function harvest(options: {
    sourceFps: number;
    strideMs: number;
    seedMs: number;
    endMs: number;
    drop?: number[];
    representSeed?: boolean;
  }): Harvested {
    const frameMs = 1000 / options.sourceFps;
    const seedFrame = Math.floor(options.seedMs / frameMs + 1e-9);
    const samples = [
      sample(options.seedMs, truth(seedFrame).x, truth(seedFrame).y),
    ];
    const arrivals: number[] = [];
    let lastKept = options.seedMs;
    const from = options.representSeed === false ? seedFrame + 1 : seedFrame;
    for (let j = from; j * frameMs <= options.endMs; j++) {
      if (options.drop?.includes(j)) {
        continue;
      }
      const pts = j * frameMs;
      arrivals.push(pts);
      if (pts - lastKept >= options.strideMs - 0.5) {
        lastKept = pts;
        samples.push(sample(pts, truth(j).x, truth(j).y));
      }
    }
    return { samples, arrivals };
  }

  /** The panel's half: measure a frame, then seat the seed on its own frame. */
  function seat(harvested: Harvested) {
    let frameMs: number | null = null;
    let previous: number | null = null;
    for (const ms of harvested.arrivals) {
      frameMs = nextFrameGap(frameMs, previous, ms);
      previous = ms;
    }
    const seed = harvested.samples[0];
    const seededAt = seekedFrameMs(
      seed.sourceMs,
      harvested.arrivals.slice(0, SEEK_ARRIVALS_NEEDED),
      frameMs,
    );
    return {
      frameMs,
      samples: [{ ...seed, sourceMs: seededAt }, ...harvested.samples.slice(1)],
    };
  }

  /**
   * The source frame on show at project frame `k`, from the clip's constant
   * speed alone: no `sourceTimeAtFrame`, no `frames.ts`.
   */
  function shownFrame(
    k: number,
    projectFps: number,
    sourceFps: number,
    clip: { startTime: number; speed: number; trimStart: number },
  ): number {
    const centreMs = ((k + 0.5) * 1000) / projectFps;
    const sourceMs = clip.trimStart + (centreMs - clip.startTime) * clip.speed;
    // A centre exactly on a frame's start shows the frame before it, as the
    // decoder does on most such frames.
    return Math.floor((sourceMs * sourceFps) / 1000 - 1e-6);
  }

  type Case = {
    projectFps: number;
    sourceFps: number;
    clip?: Record<string, any>;
    seedMs?: number;
    drop?: number[];
    representSeed?: boolean;
    measured?: boolean;
  };

  /** Run one rate pair end to end and score every frame against the oracle. */
  function run(c: Case) {
    const fields = {
      startTime: 0,
      duration: 4000,
      speed: 1,
      trim: { startTime: 0, endTime: 4000 },
      ...c.clip,
    };
    const clip = videoElement(fields);
    const harvested = harvest({
      sourceFps: c.sourceFps,
      strideMs: 1000 / c.projectFps,
      seedMs: c.seedMs ?? fields.trim.startTime,
      endMs: fields.trim.startTime + fields.duration - 1,
      drop: c.drop,
      representSeed: c.representSeed,
    });
    const seated = c.measured === false
      ? { frameMs: null, samples: harvested.samples }
      : seat(harvested);
    const path = toDisplayedPath(seated.samples, {
      elements: elements({ clip }),
      clipId: "clip",
      ...FRAME,
      fps: c.projectFps,
      sourceFrameMs: seated.frameMs,
    });
    const kept = seated.samples
      .map((s) => Math.round((s.sourceMs * c.sourceFps) / 1000))
      .sort((a, b) => a - b);
    const rows = path.map((point) => {
      const k = Math.round((point.tMs * c.projectFps) / 1000);
      const j = shownFrame(k, c.projectFps, c.sourceFps, {
        startTime: fields.startTime,
        speed: fields.speed,
        trimStart: fields.trim.startTime,
      });
      const want = toProject(truth(j));
      return { k, j, point, want, dx: point.x - want.x, dy: point.y - want.y };
    });
    return { path, rows, kept };
  }

  /**
   * Every frame whose shown source frame was tracked is exact; every other one
   * is a straight line between the kept frames either side, which misses a
   * smooth curve by at most a quarter of the gap squared, halved, times its
   * bend. Returns how many frames were interpolated.
   */
  function expectShown(result: ReturnType<typeof run>): number {
    let interpolated = 0;
    for (const row of result.rows) {
      expect(row.point.tMs).toBe(row.point.tMs);
      if (result.kept.includes(row.j)) {
        expect(Math.hypot(row.dx, row.dy)).toBeLessThan(1e-9);
        continue;
      }
      interpolated++;
      const before = Math.max(...result.kept.filter((j) => j < row.j));
      const after = Math.min(...result.kept.filter((j) => j > row.j));
      const reach = ((after - before) * (after - before)) / 8;
      expect(Math.abs(row.dx)).toBeLessThanOrEqual(reach * BEND.x + 1e-9);
      expect(Math.abs(row.dy)).toBeLessThanOrEqual(reach * BEND.y + 1e-9);
    }
    return interpolated;
  }

  it.each([
    [30, 60],
    [24, 60],
    [25, 30],
    [60, 60],
    [30, 30],
  ])("holds %ifps footage in a %ifps project exactly", (sourceFps, projectFps) => {
    const result = run({ sourceFps, projectFps });

    expect(result.rows.length).toBeGreaterThan(100);
    expect(expectShown(result)).toBe(0);
    for (const row of result.rows) {
      expect(row.point.tMs).toBe(frameToMs(row.k, projectFps));
    }
  });

  it("matches toProjectPath exactly where source and project rates agree", () => {
    const clip = videoElement();
    const { samples, frameMs } = seat(
      harvest({ sourceFps: 60, strideMs: 1000 / 60, seedMs: 0, endMs: 3999 }),
    );
    const input = { elements: elements({ clip }), clipId: "clip", ...FRAME, fps: 60 };

    expect(toDisplayedPath(samples, { ...input, sourceFrameMs: frameMs })).toEqual(
      toProjectPath(samples, input),
    );
  });

  it("is not what a null interpolating between samples showed", () => {
    // The negative control for the hold. 30fps in 60: on the odd frames a
    // straight line between samples sits half a step from the picture.
    const { rows } = run({ sourceFps: 30, projectFps: 60 });
    const halfway = rows
      .filter((row) => row.k % 2 === 1)
      .map((row) => {
        const a = toProject(truth(row.j));
        const b = toProject(truth(row.j + 1));
        return Math.hypot((a.x + b.x) / 2 - row.want.x, (a.y + b.y) / 2 - row.want.y);
      });

    expect(Math.max(...halfway)).toBeGreaterThan(1);
  });

  it.each([
    [100, 60],
    [50, 24],
    [120, 50],
  ])("interpolates the frames %ifps footage's stride skipped in %ifps", (sourceFps, projectFps) => {
    const result = run({ sourceFps, projectFps });

    expect(result.rows.length).toBeGreaterThan(80);
    expect(expectShown(result)).toBeGreaterThan(10);
  });

  it("picks the earlier frame where the frame centre lands on a boundary", () => {
    // 60 in 30: the centre of project frame k is exactly the start of source
    // frame 2k+1, and the decoder shows 2k on most such frames. The stride
    // kept exactly those, so every one is held, exactly.
    const sixty = run({ sourceFps: 60, projectFps: 30 });
    expect(sixty.rows.every((row) => row.j % 2 === 0)).toBe(true);
    expect(expectShown(sixty)).toBe(0);

    // 24 in 60 ties on every fifth frame (k = 2, 7, 12...): source frame 1, 3,
    // 5... starts exactly there, and the frame before it is the one held.
    const twentyFour = run({ sourceFps: 24, projectFps: 60 });
    const tied = twentyFour.rows.filter((row) => row.k % 5 === 2);
    expect(tied.length).toBeGreaterThan(10);
    for (const row of tied) {
      expect(row.j).toBe(Math.floor((row.k + 0.5) * 0.4) - 1);
    }
    expect(expectShown(twentyFour)).toBe(0);
  });

  it.each([
    [{ speed: 2 }, 30, 60],
    [{ speed: 0.5, duration: 1800, trim: { startTime: 0, endTime: 1800 } }, 30, 60],
    [{ startTime: 500, duration: 3000, trim: { startTime: 1000, endTime: 4000 } }, 30, 60],
    [{ startTime: 250, duration: 3000, trim: { startTime: 700, endTime: 3700 } }, 24, 30],
    [{ startTime: 250, duration: 3000, trim: { startTime: 700, endTime: 3700 } }, 24, 60],
  ])("carries the clip's speed, trim and start (%o, %ifps in %ifps)", (clip, sourceFps, projectFps) => {
    const result = run({ sourceFps, projectFps, clip });

    expect(result.rows.length).toBeGreaterThan(30);
    expectShown(result);
  });

  it("seats a seed that a seek showed late, whether or not it is presented again", () => {
    // Seeded at 700ms into 24fps footage: the frame on show starts at 666.7.
    const clip = { startTime: 250, duration: 3000, trim: { startTime: 700, endTime: 3700 } };
    const again = run({ sourceFps: 24, projectFps: 30, clip, representSeed: true });
    const once = run({ sourceFps: 24, projectFps: 30, clip, representSeed: false });

    expect(again.kept[0]).toBe(16);
    expect(once.kept[0]).toBe(16);
    expectShown(again);
    expectShown(once);
  });

  it("interpolates a frame the compositor dropped", () => {
    const result = run({ sourceFps: 30, projectFps: 60, drop: [40, 41, 77] });
    const dropped = result.rows.filter((row) => [40, 41, 77].includes(row.j));

    expect(dropped.length).toBe(6);
    expect(expectShown(result)).toBe(6);
    for (const row of dropped) {
      // Nearer the truth than holding the frame before would have been.
      const held = toProject(truth(row.j === 41 ? 39 : row.j - 1));
      expect(Math.hypot(row.dx, row.dy)).toBeLessThan(
        Math.hypot(held.x - row.want.x, held.y - row.want.y),
      );
    }
  });

  it("falls back to the samples' own spacing without a measured frame", () => {
    const held = run({ sourceFps: 30, projectFps: 60, measured: false });
    expect(expectShown(held)).toBe(0);

    // A gap of two frames is interpolated at the instant shown, not held.
    const gapped = run({ sourceFps: 30, projectFps: 60, drop: [50], measured: false });
    const around = gapped.rows.filter((row) => row.j === 50);
    expect(around.length).toBe(2);
    for (const row of around) {
      const before = toProject(truth(49));
      expect(Math.hypot(row.dx, row.dy)).toBeGreaterThan(0);
      expect(Math.hypot(row.dx, row.dy)).toBeLessThan(
        Math.hypot(before.x - row.want.x, before.y - row.want.y),
      );
    }
  });

  it("covers what was tracked and nothing more", () => {
    // Seeded at 1000ms; the samples stop when the clip does.
    const { path } = run({ sourceFps: 30, projectFps: 60, seedMs: 1000 });

    expect(path[0].tMs).toBe(1000);
    expect(path[path.length - 1].tMs).toBe(frameToMs(239, 60));
  });

  it("ends one source frame after the last sample", () => {
    const clip = videoElement();
    const samples = [sample(0, 10, 10), sample(1000 / 30, 20, 20)];
    const path = toDisplayedPath(samples, {
      elements: elements({ clip }),
      clipId: "clip",
      ...FRAME,
      fps: 60,
      sourceFrameMs: 1000 / 30,
    });

    // Two source frames, each on show for two 60fps frames.
    expect(path.map((p) => p.tMs)).toEqual([0, 1000 / 60, 2000 / 60, 3000 / 60]);
    expect(path.map((p) => p.x)).toEqual([5, 5, 10, 10]);
  });

  it("declines what toProjectPath declines", () => {
    const base = { elements: elements(), clipId: "clip", fps: 60 };

    expect(toDisplayedPath([sample(0, 1, 1)], { ...base, clipId: "nope", ...FRAME })).toEqual([]);
    expect(
      toDisplayedPath([sample(0, 1, 1)], { ...base, frameWidth: 0, frameHeight: 100 }),
    ).toEqual([]);
    expect(
      toDisplayedPath([sample(0, 1, 1)], {
        ...base,
        ...FRAME,
        elements: { clip: textElement() } as unknown as Timeline,
      }),
    ).toEqual([]);
    expect(toDisplayedPath([], { ...base, ...FRAME })).toEqual([]);
    expect(toDisplayedPath([sample(NaN, 1, 1)], { ...base, ...FRAME })).toEqual([]);
  });
});

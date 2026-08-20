import { describe, it, expect } from "vitest";
import {
  BAKE_HZ,
  MAX_BAKED_SAMPLES,
  addKeyframe,
  assertBakedInvariants,
  bakeTrack,
  cloneAnimation,
  emptyAnimation,
  moveKeyframe,
  normalizeAnimation,
  normalizeBaked,
  normalizeKeyframe,
  normalizeKeyframes,
  rebaseAnimation,
  removeKeyframe,
  sampleBaked,
  sampleTrack,
  sampleTrackXY,
  setHandles,
  shiftKeyframes,
  sliceAnimation,
  sliceKeyframes,
  type Baked,
  type Keyframe,
} from "./keyframes";
import { imageElement, keys, mulberry32, points } from "../renderer/testing";
import { handlesInBounds } from "./handleBounds";

/** A deep structural copy, for proving a function did not touch its input. */
function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

const kf = (t: number, v: number, handle = 100): Keyframe => ({
  type: "cubic",
  p: [t, v],
  cs: [t - handle, v],
  ce: [t + handle, v],
});

/**
 * A list that already satisfies the handle-bounds invariant.
 *
 * `kf` hands every keyframe a ±100ms handle, including the two on the ends
 * whose outward handles the baker never reads. That is not a state the ops can
 * produce or preserve any more — see `handleBounds` — so tests that assert on
 * handle *positions* have to start from a legal list or they are measuring the
 * clamp repairing their fixture.
 */
const legal = (...list: Keyframe[]): Keyframe[] => normalizeKeyframes(list);

// =========================================================== normalisation

describe("normalizeKeyframe", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 5],
    ["a string", "nope"],
    ["an empty object", {}],
    ["an array", []],
    ["a missing p", { cs: [0, 0], ce: [0, 0] }],
    ["a one-element p", { p: [0] }],
    ["a NaN time", { p: [NaN, 1] }],
    ["a NaN value", { p: [0, NaN] }],
    ["an Infinity time", { p: [Infinity, 1] }],
    ["a -Infinity value", { p: [0, -Infinity] }],
  ])("rejects %s", (_label, raw) => {
    expect(normalizeKeyframe(raw)).toBeNull();
  });

  it("collapses a missing handle onto the anchor", () => {
    // A keyframe with no easing is exactly a keyframe whose handles sit on it.
    expect(normalizeKeyframe({ p: [100, 5] })).toEqual({
      type: "cubic",
      p: [100, 5],
      cs: [100, 5],
      ce: [100, 5],
    });
  });

  it("accepts numeric strings, which the option inputs supply", () => {
    expect(normalizeKeyframe({ p: ["100", "5"] })?.p).toEqual([100, 5]);
  });

  it("keeps a declared linear type and defaults everything else to cubic", () => {
    expect(normalizeKeyframe({ type: "linear", p: [0, 0] })?.type).toBe("linear");
    expect(normalizeKeyframe({ type: "wat", p: [0, 0] })?.type).toBe("cubic");
    expect(normalizeKeyframe({ p: [0, 0] })?.type).toBe("cubic");
  });

  it("drops a broken handle without losing the keyframe", () => {
    const out = normalizeKeyframe({ p: [10, 2], cs: [NaN, 0], ce: [5, 1] });
    expect(out?.cs).toEqual([10, 2]);
    expect(out?.ce).toEqual([5, 1]);
  });
});

describe("normalizeKeyframes", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a non-array", { p: [0, 0] }],
    ["a string", "xx"],
  ])("returns an empty list for %s", (_label, raw) => {
    expect(normalizeKeyframes(raw)).toEqual([]);
  });

  it("drops entries it cannot repair and keeps the rest", () => {
    const out = normalizeKeyframes([
      { p: [10, 1] },
      null,
      { p: [NaN, 2] },
      { p: [0, 3] },
    ]);
    expect(out.map((k) => k.p)).toEqual([
      [0, 3],
      [10, 1],
    ]);
  });

  it("sorts by time", () => {
    const out = normalizeKeyframes([kf(300, 3), kf(100, 1), kf(200, 2)]);
    expect(out.map((k) => k.p[0])).toEqual([100, 200, 300]);
  });

  it("keeps the last of two keyframes at the same instant", () => {
    // One of them is unreachable either way; the later one wins, matching what
    // `addKeyframe` does when it lands on an occupied time.
    const out = normalizeKeyframes([kf(100, 1), kf(100, 9)]);
    expect(out).toHaveLength(1);
    expect(out[0].p[1]).toBe(9);
  });

  it("keeps negative times and times past the clip", () => {
    // A trim can push a keyframe outside the visible window, and dragging the
    // edge back out has to bring it back.
    const out = normalizeKeyframes([kf(-500, 1), kf(999_999, 2)]);
    expect(out.map((k) => k.p[0])).toEqual([-500, 999_999]);
  });

  it("never throws on hostile input", () => {
    const hostile = [
      undefined,
      null,
      0,
      "",
      [],
      {},
      { p: null },
      { p: [1, 2, 3, 4] },
      { p: [1, 2], cs: "x", ce: 7 },
    ];
    expect(() => normalizeKeyframes(hostile)).not.toThrow();
  });
});

describe("normalizeBaked", () => {
  it("turns the shipped [[], []] shape into an empty track", () => {
    // Every runtime element factory wrote this where a list of [t, value] pairs
    // belonged; the test helper wrote `[]`, so no suite ever saw it.
    expect(normalizeBaked([[], []])).toEqual([]);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a non-array", 5],
  ])("returns an empty track for %s", (_label, raw) => {
    expect(normalizeBaked(raw)).toEqual([]);
  });

  it("drops non-finite entries and keeps the rest", () => {
    expect(normalizeBaked([[0, 1], [NaN, 2], [10, 3], [20, Infinity]])).toEqual([
      [0, 1],
      [10, 3],
    ]);
  });

  it("sorts and collapses equal times", () => {
    expect(normalizeBaked([[10, 1], [0, 2], [10, 3]])).toEqual([
      [0, 2],
      [10, 3],
    ]);
  });

  it("leaves a clean array satisfying the invariant", () => {
    const clean = normalizeBaked(points([0, 1], [10, 2], [20, 3]));
    expect(() => assertBakedInvariants(clean)).not.toThrow();
  });

  it("handles a large clean array without dropping anything", () => {
    const big: Baked = Array.from({ length: 100_000 }, (_, i) => [i, i * 2]);
    const out = normalizeBaked(big);
    expect(out).toHaveLength(100_000);
    expect(() => assertBakedInvariants(out)).not.toThrow();
  });
});

// ================================================================= editing

describe("addKeyframe", () => {
  it("seeds an empty track with collapsed handles", () => {
    // There is no neighbour to ease towards, so a +-100ms handle would be a
    // curve the user never drew.
    const out = addKeyframe([], 500, 42);
    expect(out).toHaveLength(1);
    expect(out[0].p).toEqual([500, 42]);
    expect(out[0].cs).toEqual([500, 42]);
    expect(out[0].ce).toEqual([500, 42]);
  });

  it.each([
    ["before the first", 50, 0],
    ["between two", 150, 1],
    ["after the last", 500, 2],
  ])("inserts %s in sorted order", (_label, t, expectedIndex) => {
    const list = [kf(100, 1), kf(200, 2)];
    const out = addKeyframe(list, t, 9);
    expect(out.map((k) => k.p[0])).toEqual(
      [...list.map((k) => k.p[0]), t].sort((a, b) => a - b),
    );
    expect(out[expectedIndex].p).toEqual([t, 9]);
  });

  it("replaces the keyframe already at that instant, keeping its handles", () => {
    // A middle keyframe, so both of its handles are ones the baker reads and
    // the clamp leaves alone.
    const list = legal(kf(0, 0), kf(100, 1, 40), kf(200, 2));
    const out = addKeyframe(list, 100, 7);
    expect(out).toHaveLength(3);
    expect(out[1].p).toEqual([100, 7]);
    // The handle times survive; only the values follow the anchor.
    expect(out[1].cs[0]).toBe(60);
    expect(out[1].ce[0]).toBe(140);
    expect(out[1].cs[1]).toBe(7);
  });

  it("declines by identity when nothing would change", () => {
    const list = [kf(100, 1)];
    expect(addKeyframe(list, 100, 1)).toBe(list);
  });

  it.each([
    ["a NaN time", NaN, 1],
    ["a NaN value", 100, NaN],
    ["an infinite time", Infinity, 1],
  ])("declines %s by identity", (_label, t, v) => {
    const list = [kf(100, 1)];
    expect(addKeyframe(list, t, v)).toBe(list);
  });

  it("never mutates its input", () => {
    const list = [kf(100, 1), kf(200, 2)];
    const before = snapshot(list);
    const out = addKeyframe(list, 150, 5);
    expect(out).not.toBe(list);
    expect(list).toEqual(before);
  });
});

describe("moveKeyframe", () => {
  it("translates the handles with the anchor", () => {
    // The editor's drag used to flatten `cs`/`ce` to `[px-100, py]`/`[px+100,
    // py]` on every mousemove, so any easing the user drew was destroyed the
    // moment they nudged the point.
    // Neighbours on both sides, and room between them, so the translated
    // handles land inside their bounds and the clamp has nothing to say.
    const list = legal(kf(0, 0), kf(100, 1, 40), kf(500, 9));
    const { list: out } = moveKeyframe(list, 1, 300, 5);
    expect(out[1].p).toEqual([300, 5]);
    expect(out[1].cs).toEqual([260, 5]);
    expect(out[1].ce).toEqual([340, 5]);
  });

  it("re-sorts and reports the corrected index when dragged past a neighbour", () => {
    // Holding the old index would move a different keyframe on the next
    // mousemove, and left the authored list unsorted for the baker.
    const list = [kf(100, 1), kf(200, 2), kf(300, 3)];
    const { list: out, index } = moveKeyframe(list, 0, 250, 1);
    expect(out.map((k) => k.p[0])).toEqual([200, 250, 300]);
    expect(index).toBe(1);
    expect(out[index].p).toEqual([250, 1]);
  });

  it("re-sorts when dragged left past a neighbour", () => {
    const list = [kf(100, 1), kf(200, 2), kf(300, 3)];
    const { list: out, index } = moveKeyframe(list, 2, 150, 3);
    expect(out.map((k) => k.p[0])).toEqual([100, 150, 200]);
    expect(index).toBe(1);
  });

  it("refuses to land exactly on another keyframe", () => {
    // Otherwise one of the two becomes unreachable. A blocked drag comes to
    // rest against its neighbour instead of eating it.
    const list = [kf(100, 1), kf(200, 2)];
    const out = moveKeyframe(list, 0, 200, 9);
    expect(out.list).toBe(list);
    expect(out.index).toBe(0);
  });

  it("allows a move to a negative time", () => {
    const { list: out } = moveKeyframe([kf(100, 1)], 0, -50, 1);
    expect(out[0].p[0]).toBe(-50);
  });

  it.each([-1, 1, 99])("declines an out-of-range index %s by identity", (i) => {
    const list = [kf(100, 1)];
    expect(moveKeyframe(list, i, 5, 5).list).toBe(list);
  });

  it("declines a zero-delta move by identity", () => {
    const list = [kf(100, 1)];
    expect(moveKeyframe(list, 0, 100, 1).list).toBe(list);
  });

  it("never mutates its input", () => {
    const list = [kf(100, 1), kf(200, 2)];
    const before = snapshot(list);
    moveKeyframe(list, 0, 500, 9);
    expect(list).toEqual(before);
  });
});

describe("setHandles", () => {
  it("replaces one handle and leaves the other", () => {
    const list = legal(kf(0, 0), kf(100, 1), kf(300, 4));
    const out = setHandles(list, 1, { cs: [50, 3] });
    expect(out[1].cs).toEqual([50, 3]);
    expect(out[1].ce).toEqual(list[1].ce);
    expect(out[1].p).toEqual([100, 1]);
  });

  it("folds a handle dragged past its neighbour onto the boundary", () => {
    // The editor drew the handle wherever the pointer went while `bakeTrack`
    // clamped the abscissa before solving, so past the neighbour the handle
    // kept moving and the curve stopped changing. See `handleBounds`.
    const list = legal(kf(0, 0), kf(100, 1), kf(300, 4));
    const out = setHandles(list, 1, { cs: [-900, 3], ce: [9000, 7] });
    expect(out[1].cs[0]).toBe(0);
    expect(out[1].ce[0]).toBe(300);
    // Time only. The value axis stays free, which is what makes overshoot and
    // bounce easings expressible.
    expect(out[1].cs[1]).toBe(3);
    expect(out[1].ce[1]).toBe(7);
  });

  it("declines an empty patch and an out-of-range index by identity", () => {
    const list = [kf(100, 1)];
    expect(setHandles(list, 0, {})).toBe(list);
    expect(setHandles(list, 5, { cs: [0, 0] })).toBe(list);
  });
});

describe("removeKeyframe", () => {
  it.each([
    ["the first", 0, [200, 300]],
    ["a middle one", 1, [100, 300]],
    ["the last", 2, [100, 200]],
  ])("removes %s", (_label, index, expected) => {
    const list = [kf(100, 1), kf(200, 2), kf(300, 3)];
    expect(removeKeyframe(list, index).map((k) => k.p[0])).toEqual(expected);
  });

  it("empties the track when the only keyframe goes", () => {
    // And the bake must empty with it, or the renderer keeps applying the
    // animation the user just deleted.
    const out = removeKeyframe([kf(100, 1)], 0);
    expect(out).toEqual([]);
    expect(bakeTrack(out)).toEqual([]);
  });

  it.each([-1, 3, 99])("declines an out-of-range index %s by identity", (i) => {
    const list = [kf(100, 1), kf(200, 2), kf(300, 3)];
    expect(removeKeyframe(list, i)).toBe(list);
  });
});

describe("add / remove round trip", () => {
  it("returns the original list for 200 seeded random cases", () => {
    const random = mulberry32(0xc0ffee);
    for (let round = 0; round < 200; round++) {
      const size = 1 + Math.floor(random() * 8);
      const times = new Set<number>();
      while (times.size < size) {
        times.add(Math.floor(random() * 4000));
      }
      // Through `legal`, because the round trip is a property of lists the ops
      // can actually produce. A raw `kf` list has live handles on both ends,
      // which the first op through would repair — and the repair, not the
      // add/remove pair, would be what the comparison caught.
      const list = legal(
        ...[...times]
          .sort((a, b) => a - b)
          .map((t) => kf(t, Math.floor(random() * 100))),
      );

      let fresh = Math.floor(random() * 4000);
      while (times.has(fresh)) {
        fresh = (fresh + 1) % 4000;
      }

      const added = addKeyframe(list, fresh, 42);
      const index = added.findIndex((k) => k.p[0] === fresh);
      expect(index).toBeGreaterThanOrEqual(0);

      const back = removeKeyframe(added, index);
      // Anchors, not whole keyframes. Handle bounds depend on the neighbours,
      // so inserting can narrow a neighbour's handle and removing does not
      // widen it back — see the test below, which pins that down deliberately.
      // What this fuzz is for is the insert/remove *positioning*: that the
      // fresh keyframe lands in sorted order and that removing it restores
      // exactly the anchors that were there before.
      expect(back.map((k) => k.p)).toEqual(list.map((k) => k.p));
      expect(handlesInBounds(back)).toBe(true);
    }
  });

  // Recorded because it is a real consequence of constraining handles, not an
  // oversight: the clamp is lossy. Inserting a keyframe close to its neighbour
  // folds that neighbour's handle onto the new anchor, and removing the
  // keyframe again leaves the handle where the clamp put it. Undo is what
  // restores the original curve, which is why every editor gesture is one
  // checkpoint.
  it("does not restore a handle that inserting had folded in", () => {
    const list = legal(kf(0, 0), kf(1000, 50), kf(2000, 100));
    expect(list[1].cs[0]).toBe(900);

    const added = addKeyframe(list, 950, 42);
    expect(added[2].cs[0]).toBe(950);

    const back = removeKeyframe(added, 1);
    expect(back.map((k) => k.p[0])).toEqual([0, 1000, 2000]);
    expect(back[1].cs[0]).toBe(950);
  });
});

// ================================================================== baking

describe("bakeTrack", () => {
  it("bakes an empty track to an empty array", () => {
    expect(bakeTrack([])).toEqual([]);
  });

  it("bakes a single keyframe to its own value", () => {
    expect(bakeTrack([kf(250, 7)])).toEqual([[250, 7]]);
  });

  it("collapses a track whose keyframes all share one instant", () => {
    const out = bakeTrack([kf(100, 1), kf(100, 2)]);
    expect(out).toEqual([[100, 2]]);
  });

  it("puts the exact authored endpoints at both ends", () => {
    // Float accumulation in `t += 1/n` meant the final sample — the last
    // keyframe's own value — was usually skipped entirely.
    const out = bakeTrack([kf(0, 10), kf(1000, 90)]);
    expect(out[0]).toEqual([0, 10]);
    expect(out[out.length - 1]).toEqual([1000, 90]);
  });

  it.each([1, 2, 4, 5, 7])(
    "emits both endpoints for a %sms segment",
    (interval) => {
      // Segments of 5ms or less used to produce no samples at all, leaving a
      // hole; and `Math.round(interval / (1000/60))` reached 0 below ~8ms, so
      // the `t += 1/0` that followed emitted one sample and stopped.
      const start = Date.now();
      const out = bakeTrack([kf(0, 0), kf(interval, 100)]);
      expect(Date.now() - start).toBeLessThan(1000);
      expect(out.length).toBeGreaterThanOrEqual(2);
      expect(out[0]).toEqual([0, 0]);
      expect(out[out.length - 1]).toEqual([interval, 100]);
    },
  );

  it("emits each join time exactly once", () => {
    // Adjoining segments each used to emit the shared join.
    const out = bakeTrack([kf(0, 0), kf(500, 50), kf(1000, 100)]);
    const times = out.map(([t]) => t);
    expect(new Set(times).size).toBe(times.length);
    expect(times).toContain(500);
  });

  it("samples at roughly the bake rate", () => {
    const out = bakeTrack([kf(0, 0), kf(1000, 100)]);
    expect(out.length).toBeGreaterThanOrEqual(BAKE_HZ);
    expect(out.length).toBeLessThan(BAKE_HZ * 2);
  });

  it("honours an explicit rate and clamps a nonsense one", () => {
    expect(bakeTrack([kf(0, 0), kf(1000, 100)], 10).length).toBeLessThan(20);
    for (const bad of [0, -5, NaN, Infinity]) {
      const out = bakeTrack([kf(0, 0), kf(1000, 100)], bad);
      expect(out.length).toBeGreaterThan(1);
      expect(() => assertBakedInvariants(out)).not.toThrow();
    }
  });

  it("lerps a linear segment exactly", () => {
    const list: Keyframe[] = [
      { type: "linear", p: [0, 0], cs: [0, 0], ce: [0, 0] },
      { type: "linear", p: [1000, 100], cs: [1000, 100], ce: [1000, 100] },
    ];
    expect(sampleBaked(bakeTrack(list), 500, -1)).toBeCloseTo(50, 5);
  });

  it("stays under the sample ceiling on a very long track", () => {
    const out = bakeTrack([kf(0, 0), kf(30 * 60 * 1000, 100)]);
    expect(out.length).toBeLessThanOrEqual(MAX_BAKED_SAMPLES);
    expect(() => assertBakedInvariants(out)).not.toThrow();
  });

  it("covers the whole track when the ceiling bites, coarsening instead of stopping", () => {
    // Clamping the sample *count* while holding the step baked only the first
    // `budget * step` of a long track: a twenty-minute fade froze ten minutes
    // in and then jumped to its end value. The step has to grow instead.
    const end = 20 * 60 * 1000;
    const out = bakeTrack([kf(0, 0), kf(end, 100)]);

    expect(out[0][0]).toBe(0);
    expect(out.at(-1)![0]).toBe(end);
    expect(out.at(-1)![1]).toBe(100);

    // And it really is still a ramp at three-quarters, not a frozen value.
    expect(sampleBaked(out, end * 0.75, -1)).toBeGreaterThan(60);
    expect(sampleBaked(out, end * 0.75, -1)).toBeLessThan(90);
    expect(sampleBaked(out, end * 0.5, -1)).toBeGreaterThan(35);
    expect(() => assertBakedInvariants(out)).not.toThrow();
  });

  it("holds the invariant across 500 seeded random tracks", () => {
    // The old baker evaluated the bezier on the *time* axis too, so `ax` ran
    // backwards whenever handles crossed. Non-monotonic time makes binary
    // search impossible and "the keyframe at 400ms" meaningless.
    const random = mulberry32(0x5eed);
    for (let round = 0; round < 500; round++) {
      const size = 2 + Math.floor(random() * 19);
      const times = new Set<number>();
      while (times.size < size) {
        times.add(Math.floor(random() * 6000));
      }
      const sorted = [...times].sort((a, b) => a - b);
      const list: Keyframe[] = sorted.map((t) => {
        const v = random() * 200 - 100;
        // Handles deliberately allowed to cross, invert and overshoot.
        const csOffset = (random() - 0.3) * 4000;
        const ceOffset = (random() - 0.7) * 4000;
        return {
          type: "cubic",
          p: [t, v],
          cs: [t + csOffset, v + (random() - 0.5) * 200],
          ce: [t + ceOffset, v + (random() - 0.5) * 200],
        };
      });

      const out = bakeTrack(list);
      expect(() => assertBakedInvariants(out, `round ${round}`)).not.toThrow();
      expect(out[0][0]).toBe(sorted[0]);
      expect(out[out.length - 1][0]).toBe(sorted[sorted.length - 1]);
    }
  });

  it("follows the authored easing rather than a straight line", () => {
    // A handle pulling the value high early must show up in the bake, or the
    // curve editor is decorative.
    const list: Keyframe[] = [
      { type: "cubic", p: [0, 0], cs: [0, 0], ce: [100, 100] },
      { type: "cubic", p: [1000, 100], cs: [900, 100], ce: [1000, 100] },
    ];
    expect(sampleBaked(bakeTrack(list), 250, -1)).toBeGreaterThan(25);
  });

  it("bakes a 5,000-keyframe track in reasonable time", () => {
    const list = Array.from({ length: 5000 }, (_, i) => kf(i * 20, i % 100));
    const start = Date.now();
    const out = bakeTrack(list);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(() => assertBakedInvariants(out)).not.toThrow();
  });
});

// ================================================================ sampling

describe("sampleBaked", () => {
  const track = points([0, 0], [1000, 100], [2000, 50]);

  it("snaps to the nearest sample rather than blending", () => {
    expect(sampleBaked(track, 0, -1)).toBe(0);
    expect(sampleBaked(track, 600, -1)).toBe(100);
    expect(sampleBaked(track, 2000, -1)).toBe(50);
  });

  it("breaks ties toward the earlier sample", () => {
    // The linear scan compared with a strict `<`, so the first minimum won.
    expect(sampleBaked(points([0, 10], [1000, 20]), 500, -1)).toBe(10);
  });

  it("holds the first sample before the track and the last one after it", () => {
    expect(sampleBaked(track, -99_999, -1)).toBe(0);
    expect(sampleBaked(track, 999_999, -1)).toBe(50);
  });

  it("falls back on an empty track", () => {
    expect(sampleBaked([], 100, 42)).toBe(42);
  });

  it("falls back on a non-finite cursor", () => {
    expect(sampleBaked(track, NaN, 42)).toBe(42);
    expect(sampleBaked(track, Infinity, 42)).toBe(42);
  });

  it.each([
    [[[5, 7]] as Baked, 0, 7],
    [[[5, 7]] as Baked, 999, 7],
    [
      [
        [0, 1],
        [10, 2],
      ] as Baked,
      4,
      1,
    ],
  ])("handles a tiny track %#", (baked, t, expected) => {
    expect(sampleBaked(baked, t, -1)).toBe(expected);
  });

  it("returns a value of zero rather than the fallback", () => {
    // `ax || location.x` in the panel copies made an animated 0 — the left
    // edge, fully transparent, no rotation — fall back to the static value.
    expect(sampleBaked(points([0, 0]), 0, 999)).toBe(0);
  });

  /**
   * The proof that the O(log n) rewrite is behaviour-identical, and therefore
   * the reason the golden snapshots can stay untouched.
   */
  it("matches the linear scan it replaces over 10,000 random cases", () => {
    const oldScan = (pairs: number[][], a: number): number | null => {
      let closestY: number | null = null;
      let closestDiff = Infinity;
      for (const [time, value] of pairs) {
        const diff = Math.abs(time - a);
        if (diff < closestDiff) {
          closestDiff = diff;
          closestY = value;
        }
      }
      return closestY;
    };

    const random = mulberry32(0xbeef);
    for (let round = 0; round < 10_000; round++) {
      const size = Math.floor(random() * 12);
      const times = new Set<number>();
      while (times.size < size) {
        // A small pool so duplicate and adjacent times come up often.
        times.add(Math.floor(random() * 40) - 10);
      }
      const baked: Baked = [...times]
        .sort((a, b) => a - b)
        .map((t) => [t, Math.floor(random() * 100)]);

      // Cursors inside, on, and well outside the range.
      const t = Math.floor(random() * 60) - 20;
      expect(sampleBaked(baked, t, -1)).toBe(oldScan(baked, t) ?? -1);
    }
  });

  it("returns a value from the array on unsorted input rather than throwing", () => {
    // Binary search needs sorted input, which `bakeTrack` and `normalizeBaked`
    // both guarantee. Legacy data that reached the store another way must
    // still degrade quietly.
    const unsorted: Baked = [
      [100, 1],
      [0, 2],
      [50, 3],
    ];
    const values = unsorted.map(([, v]) => v);
    expect(() => sampleBaked(unsorted, 40, -1)).not.toThrow();
    expect(values).toContain(sampleBaked(unsorted, 40, -1));
  });

  it("samples a 100,000-entry track 200,000 times well inside budget", () => {
    // A regression to the linear scan is roughly 1000x over this, so the bound
    // is loose enough that CI noise cannot flake it.
    const baked: Baked = Array.from({ length: 100_000 }, (_, i) => [i * 10, i]);
    const start = Date.now();
    let sink = 0;
    for (let i = 0; i < 200_000; i++) {
      sink += sampleBaked(baked, (i * 37) % 1_000_000, -1);
    }
    expect(Date.now() - start).toBeLessThan(2000);
    expect(sink).toBeGreaterThan(0);
  });
});

describe("sampleTrack / sampleTrackXY", () => {
  const track = { ax: points([0, 10], [1000, 90]) };

  it("samples relative to the element's own start time", () => {
    expect(sampleTrack(track, 0, 1000, -1)).toBe(90);
    expect(sampleTrack(track, 1000, 1000, -1)).toBe(10);
    expect(sampleTrack(track, 1000, 2000, -1)).toBe(90);
  });

  it("falls back before the element starts", () => {
    // The guard this replaces rounded the cursor onto a 16ms frame and remapped
    // it onto a 20ms grid — a 25% error that let a cursor a full second early
    // still snap to the first keyframe.
    expect(sampleTrack(track, 5000, 4000, 42)).toBe(42);
    expect(sampleTrack(track, 5000, 0, 42)).toBe(42);
  });

  it("samples exactly at the element's start", () => {
    expect(sampleTrack(track, 5000, 5000, 42)).toBe(10);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a track with no ax", {}],
    ["a track with a broken ax", { ax: "nope" }],
  ])("falls back for %s", (_label, raw) => {
    expect(sampleTrack(raw as any, 0, 100, 42)).toBe(42);
  });

  it("samples both lanes independently", () => {
    const vector = { ax: points([0, 1], [1000, 2]), ay: points([0, 3], [1000, 4]) };
    expect(sampleTrackXY(vector, 0, 1000, -1, -1)).toEqual({ x: 2, y: 4 });
  });

  it("falls back per lane when only one is populated", () => {
    const half = { ax: points([0, 5]), ay: [] };
    expect(sampleTrackXY(half, 0, 100, -1, 77)).toEqual({ x: 5, y: 77 });
  });

  it("returns an animated zero rather than the fallback", () => {
    const zeroed = { ax: points([0, 0]), ay: points([0, 0]) };
    expect(sampleTrackXY(zeroed, 0, 0, 500, 500)).toEqual({ x: 0, y: 0 });
  });
});

// ======================================================== element helpers

describe("emptyAnimation", () => {
  it("gives all four tracks to image, video and text", () => {
    for (const filetype of ["image", "video", "text"]) {
      expect(Object.keys(emptyAnimation(filetype)).sort()).toEqual([
        "opacity",
        "position",
        "rotation",
        "scale",
      ]);
    }
  });

  it("gives shape opacity alone, matching its type", () => {
    expect(Object.keys(emptyAnimation("shape"))).toEqual(["opacity"]);
  });

  it("gives gif and audio no animation block at all", () => {
    expect(emptyAnimation("gif")).toBeUndefined();
    expect(emptyAnimation("audio")).toBeUndefined();
  });

  it("uses the flat baked shape, not the [[], []] the factories wrote", () => {
    const animation = emptyAnimation("image");
    expect(animation.position.ax).toEqual([]);
    expect(animation.position.ay).toEqual([]);
    expect(animation.opacity.ax).toEqual([]);
  });
});

describe("normalizeAnimation", () => {
  it("repairs the legacy [[], []] baked shape", () => {
    const el = imageElement({
      animation: {
        ...(imageElement().animation as any),
        position: {
          isActivate: false,
          x: [],
          y: [],
          ax: [[], []],
          ay: [[], []],
        },
      } as any,
    });
    const out = normalizeAnimation(el);
    expect(out).not.toBe(el);
    expect(out.animation.position.ax).toEqual([]);
    expect(out.animation.position.ay).toEqual([]);
  });

  it("returns a clean element by identity", () => {
    const el = imageElement();
    expect(normalizeAnimation(el)).toBe(el);
  });

  it("returns an element with no animation block by identity", () => {
    const el = { filetype: "audio", startTime: 0 } as any;
    expect(normalizeAnimation(el)).toBe(el);
  });

  it("sorts an unsorted authored track", () => {
    const el = imageElement({
      animation: {
        ...(imageElement().animation as any),
        opacity: { isActivate: true, x: keys([200, 2], [100, 1]), ax: [] },
      } as any,
    });
    expect(normalizeAnimation(el).animation.opacity.x.map((k) => k.p[0])).toEqual(
      [100, 200],
    );
  });

  it("repairs a keyframe whose handles are the broken part", () => {
    // The change detector compared only `p`, so an element whose handles were
    // malformed looked unchanged, the repaired copy was discarded, and the
    // original went back into the store to throw on the first bake.
    const el = imageElement({
      animation: {
        ...(imageElement().animation as any),
        opacity: {
          isActivate: true,
          x: [{ type: "cubic", p: [0, 0] }, { type: "cubic", p: [1000, 100] }],
          ax: [],
        },
      } as any,
    });

    const out = normalizeAnimation(el);
    expect(out).not.toBe(el);
    for (const keyframe of out.animation.opacity.x) {
      expect(keyframe.cs).toHaveLength(2);
      expect(keyframe.ce).toHaveLength(2);
    }
    expect(() => bakeTrack(out.animation.opacity.x)).not.toThrow();
  });

  it("repairs a keyframe whose type is wrong", () => {
    const el = imageElement({
      animation: {
        ...(imageElement().animation as any),
        opacity: {
          isActivate: true,
          x: [{ type: "bogus", p: [0, 0], cs: [0, 0], ce: [0, 0] }],
          ax: [],
        },
      } as any,
    });
    expect(normalizeAnimation(el).animation.opacity.x[0].type).toBe("cubic");
  });

  it("never throws on a hostile animation block", () => {
    const el = imageElement({
      animation: { position: "nope", opacity: null, scale: 5 } as any,
    });
    expect(() => normalizeAnimation(el)).not.toThrow();
  });
});

describe("cloneAnimation", () => {
  it("shares no object with its input", () => {
    // `splitAt` and `pasteClips` both build results with `{...element}`, so the
    // pieces shared one animation object — editing a keyframe on one half of a
    // split silently changed the other.
    const el = imageElement({
      animation: {
        ...(imageElement().animation as any),
        opacity: { isActivate: true, x: keys([0, 0], [1000, 100]), ax: points([0, 0]) },
      } as any,
    });
    const copy = cloneAnimation(el);

    expect(copy.animation).not.toBe(el.animation);
    expect(copy.animation.opacity).not.toBe(el.animation.opacity);
    expect(copy.animation.opacity.x).not.toBe(el.animation.opacity.x);
    expect(copy.animation.opacity.x[0]).not.toBe(el.animation.opacity.x[0]);
    expect(copy.animation.opacity.x[0].p).not.toBe(el.animation.opacity.x[0].p);
    expect(copy.animation.opacity.ax[0]).not.toBe(el.animation.opacity.ax[0]);
    expect(copy.animation).toEqual(el.animation);
  });

  it("returns an element with no animation by identity", () => {
    const el = { filetype: "audio" } as any;
    expect(cloneAnimation(el)).toBe(el);
  });
});

describe("rebaseAnimation", () => {
  const animated = () =>
    imageElement({
      animation: {
        ...(imageElement().animation as any),
        opacity: {
          isActivate: true,
          x: keys([1000, 10], [2000, 90]),
          ax: points([1000, 10], [2000, 90]),
        },
      } as any,
    });

  it("slides the authored keyframes", () => {
    const out = rebaseAnimation(animated(), 500);
    expect(out.animation.opacity.x.map((k) => k.p[0])).toEqual([500, 1500]);
  });

  it("re-bakes rather than shifting the old samples", () => {
    // The two are the same curve, but the baker's grid is `t0 + i * step`, so
    // shifting `t0` and shifting each sample disagree in the last bits of a
    // float — enough to break `ax === bakeTrack(x)`, which the document ops
    // rely on.
    const out = rebaseAnimation(animated(), 500);
    expect(out.animation.opacity.ax).toEqual(bakeTrack(out.animation.opacity.x));
    expect(out.animation.opacity.ax[0][0]).toBe(500);
    expect(out.animation.opacity.ax.at(-1)![0]).toBe(1500);
  });

  it("shifts stale samples when there are no keyframes to re-bake from", () => {
    // A project written before the authored list was persisted can carry
    // samples with nothing behind them; re-baking would delete that animation.
    const el = imageElement({
      animation: {
        ...(imageElement().animation as any),
        opacity: { isActivate: true, x: [], ax: points([1000, 10], [2000, 90]) },
      } as any,
    });
    const out = rebaseAnimation(el, 500);
    expect(out.animation.opacity.ax.map(([t]: number[]) => t)).toEqual([
      500, 1500,
    ]);
  });

  it("slides handles with their anchors", () => {
    const out = rebaseAnimation(animated(), 500);
    expect(out.animation.opacity.x[0].cs[0]).toBe(500);
    expect(out.animation.opacity.x[0].ce[0]).toBe(500);
  });

  it("accepts a negative delta", () => {
    const out = rebaseAnimation(animated(), -500);
    expect(out.animation.opacity.x.map((k) => k.p[0])).toEqual([1500, 2500]);
  });

  it.each([0, NaN, Infinity])("declines a delta of %s by identity", (delta) => {
    const el = animated();
    expect(rebaseAnimation(el, delta)).toBe(el);
  });

  it("returns an element with no keyframes by identity", () => {
    const el = imageElement();
    expect(rebaseAnimation(el, 500)).toBe(el);
  });

  it("never mutates its input", () => {
    const el = animated();
    const before = snapshot(el.animation);
    rebaseAnimation(el, 500);
    expect(el.animation).toEqual(before);
  });
});

describe("sliceKeyframes / sliceAnimation", () => {
  it("drops keyframes outside the window", () => {
    const list = [kf(0, 0), kf(500, 50), kf(1000, 100)];
    const out = sliceKeyframes(list, 400, 1000);
    expect(out.map((k) => k.p[0])).toContain(500);
    expect(out.map((k) => k.p[0])).not.toContain(0);
  });

  it("pins the boundary to the value the uncut track showed there", () => {
    // Simply dropping what falls outside would change the picture at the seam:
    // the value at the cut is generally partway along a curve.
    const list = [kf(0, 0), kf(1000, 100)];
    const out = sliceKeyframes(list, 500, 1000);
    const boundary = out.find((k) => k.p[0] === 500);
    expect(boundary).toBeDefined();
    expect(boundary!.p[1]).toBeCloseTo(sampleBaked(bakeTrack(list), 500, -1), 5);
  });

  it("subdivides the segment instead of planting default handles", () => {
    // Exactness matters: a split must not change what plays. Planting a
    // keyframe with the right *value* but default handles leaves the segment
    // either side of the cut bowing differently from the uncut curve.
    const list: Keyframe[] = [
      { type: "cubic", p: [0, 0], cs: [0, 0], ce: [600, 90] },
      { type: "cubic", p: [1000, 100], cs: [400, 10], ce: [1000, 100] },
    ];
    const whole = bakeTrack(list);

    const left = sliceKeyframes(list, 0, 400);
    const right = sliceKeyframes(list, 400, 1000);

    for (let t = 0; t <= 1000; t += 10) {
      const half = t <= 400 ? bakeTrack(left) : bakeTrack(right);
      // Both sides bake onto grids offset from each other and sampling snaps,
      // so half a sample of the curve is the only permitted difference.
      const perSample = (100 * (1000 / 60)) / 1000;
      expect(
        Math.abs(sampleBaked(half, t, -1) - sampleBaked(whole, t, -1)),
      ).toBeLessThanOrEqual(perSample);
    }
  });

  it("holds the end value for a window past the last keyframe", () => {
    // The tail piece of a clip split several times: the window starts after
    // every authored keyframe. Slicing it to nothing would stop the animation.
    const list = [kf(0, 0), kf(1000, 100)];
    const out = sliceKeyframes(list, 2000, 3000);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((k) => k.p[1] === 100)).toBe(true);
  });

  it("holds the start value for a window before the first keyframe", () => {
    const list = [kf(1000, 7), kf(2000, 9)];
    const out = sliceKeyframes(list, 0, 500);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((k) => k.p[1] === 7)).toBe(true);
  });

  it("subdivides a linear segment as a plain lerp", () => {
    const list: Keyframe[] = [
      { type: "linear", p: [0, 0], cs: [0, 0], ce: [0, 0] },
      { type: "linear", p: [1000, 100], cs: [1000, 100], ce: [1000, 100] },
    ];
    const out = sliceKeyframes(list, 250, 1000);
    expect(out[0].p[0]).toBe(250);
    expect(out[0].p[1]).toBeCloseTo(25, 5);
  });

  it("returns the list by identity when nothing falls outside", () => {
    const list = [kf(100, 1), kf(200, 2)];
    expect(sliceKeyframes(list, 0, 1000)).toBe(list);
  });

  it("declines an inverted or degenerate window by identity", () => {
    const list = [kf(100, 1)];
    expect(sliceKeyframes(list, 500, 100)).toBe(list);
    expect(sliceKeyframes(list, 100, 100)).toBe(list);
    expect(sliceKeyframes(list, NaN, 100)).toBe(list);
  });

  it("re-bakes each lane it slices", () => {
    const el = imageElement({
      animation: {
        ...(imageElement().animation as any),
        opacity: {
          isActivate: true,
          x: keys([0, 0], [500, 50], [1000, 100]),
          ax: points([0, 0]),
        },
      } as any,
    });
    const out = sliceAnimation(el, 400, 1000);
    expect(out.animation.opacity.ax).toEqual(
      bakeTrack(out.animation.opacity.x),
    );
  });

  it("trims stale samples rather than erasing a legacy track", () => {
    // Baked samples with no keyframes behind them: re-baking from the empty
    // authored list would delete the animation, the case `rebaseAnimation`
    // already guards.
    const el = imageElement({
      animation: {
        ...(imageElement().animation as any),
        opacity: {
          isActivate: true,
          x: [],
          ax: points([0, 0], [500, 50], [1000, 100]),
        },
      } as any,
    });
    const out = sliceAnimation(el, 400, 1000);
    expect(out.animation.opacity.ax).toEqual([
      [500, 50],
      [1000, 100],
    ]);
  });

  it("deep-copies even when the window changes nothing", () => {
    const el = imageElement({
      animation: {
        ...(imageElement().animation as any),
        opacity: { isActivate: true, x: keys([100, 1]), ax: points([100, 1]) },
      } as any,
    });
    const out = sliceAnimation(el, 0, 4000);
    expect(out.animation.opacity.x[0]).not.toBe(el.animation.opacity.x[0]);
  });
});

describe("shiftKeyframes", () => {
  it("declines a zero or non-finite delta by identity", () => {
    const list = [kf(100, 1)];
    expect(shiftKeyframes(list, 0)).toBe(list);
    expect(shiftKeyframes(list, NaN)).toBe(list);
  });

  it("declines an empty list by identity", () => {
    const list: Keyframe[] = [];
    expect(shiftKeyframes(list, 100)).toBe(list);
  });
});

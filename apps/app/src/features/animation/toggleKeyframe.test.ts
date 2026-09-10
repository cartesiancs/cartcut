/**
 * The sidebar diamond's op.
 *
 * Two properties carry the whole feature and both are about *not moving the
 * picture*: adding a keyframe must not bend the curve it lands on, and removing
 * the last one must not drop the clip back to a stale static value. Both are
 * asserted through what the renderer would actually draw — `localSampleAt` —
 * rather than through the shape of the keyframe list, because the list can be
 * right while the picture is wrong.
 */
import { describe, it, expect } from "vitest";
import { toggleKeyframe } from "./keyframeOps";
import { bakeTrack, sampleBaked } from "./keyframes";
import { localSampleAt } from "../timeline/transform";
import { SCHEMA_VERSION, createTrack, type TimelineDocument } from "../timeline/tracks";

const FPS = 60;
const START = 1000;

const keys = (...pairs: Array<[number, number]>) =>
  pairs.map(([t, v]) => ({
    type: "cubic" as const,
    p: [t, v] as [number, number],
    cs: [t - 100, v] as [number, number],
    ce: [t + 100, v] as [number, number],
  }));

const lane = (list: any[]) => ({ list, baked: bakeTrack(list) });

function doc(animation: Record<string, any>, over: Record<string, any> = {}): TimelineDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements: {
      a: {
        filetype: "video",
        startTime: START,
        duration: 2000,
        location: { x: 10, y: 20 },
        width: 100,
        height: 100,
        opacity: 100,
        rotation: 0,
        animation,
        ...over,
      } as any,
    },
  };
}

const positionTrack = (over: Record<string, any> = {}) => {
  const x = over.x ?? [];
  const y = over.y ?? [];
  return { isActivate: true, x, y, ax: bakeTrack(x), ay: bakeTrack(y), ...over };
};

const el = (d: TimelineDocument) => d.elements.a as any;
const posLanes = (d: TimelineDocument) => ({
  x: el(d).animation.position.x.map((k: any) => k.p),
  y: el(d).animation.position.y.map((k: any) => k.p),
});
const toggle = (d: TimelineDocument, cursorMs: number, property = "position") =>
  toggleKeyframe(d, "a", property as any, cursorMs, FPS);

describe("toggleKeyframe", () => {
  describe("arming", () => {
    it("arms an unarmed property and seeds one keyframe here", () => {
      const base = doc({ position: positionTrack({ isActivate: false }) });
      const out = toggle(base, START + 500);
      expect(el(out).animation.position.isActivate).toBe(true);
      expect(posLanes(out)).toEqual({ x: [[500, 10]], y: [[500, 20]] });
    });

    // `setTrackActive` only seeds *empty* lanes, so arming a track that still
    // holds the user's curve seeds nothing — and an `else if` would have left
    // the click with no keyframe to show for itself.
    it("plants a keyframe when arming a track that kept its curve", () => {
      const base = doc({
        position: positionTrack({
          isActivate: false,
          x: keys([0, 0], [1000, 100]),
          y: keys([0, 0], [1000, 100]),
        }),
      });
      const out = toggle(base, START + 500);
      expect(el(out).animation.position.isActivate).toBe(true);
      expect(posLanes(out).x.map((p: number[]) => p[0])).toEqual([0, 500, 1000]);
    });
  });

  describe("adding", () => {
    const curved = () =>
      doc({
        position: positionTrack({
          x: keys([0, 0], [1000, 100]),
          y: keys([0, 0], [1000, 100]),
        }),
      });

    it("adds one keyframe per lane at the playhead", () => {
      const out = toggle(curved(), START + 400);
      expect(posLanes(out).x.map((p: number[]) => p[0])).toEqual([0, 400, 1000]);
      expect(posLanes(out).y.map((p: number[]) => p[0])).toEqual([0, 400, 1000]);
    });

    // The one that matters. `addKeyframe` would seat fresh +/-100ms handles and
    // re-shape the motion either side of the new point; `plantKeyframe`
    // subdivides the existing segment exactly.
    it("does not change the curve it lands on", () => {
      const before = curved();
      const after = toggle(before, START + 400);
      for (const key of ["ax", "ay"] as const) {
        const b = el(before).animation.position[key];
        const a = el(after).animation.position[key];
        for (let t = 0; t <= 1000; t += 25) {
          expect(sampleBaked(a, t, NaN)).toBeCloseTo(sampleBaked(b, t, NaN), 6);
        }
      }
    });

    it("seeds an empty sibling lane from the static value", () => {
      const base = doc({
        position: positionTrack({ x: keys([0, 0], [1000, 100]), y: [] }),
      });
      const out = toggle(base, START + 400);
      expect(posLanes(out).y).toEqual([[400, 20]]);
    });
  });

  describe("removing", () => {
    it("removes both lanes' keyframes at the playhead", () => {
      const base = doc({
        position: positionTrack({
          x: keys([0, 0], [400, 40], [1000, 100]),
          y: keys([0, 0], [400, 40], [1000, 100]),
        }),
      });
      const out = toggle(base, START + 400);
      expect(posLanes(out).x.map((p: number[]) => p[0])).toEqual([0, 1000]);
      expect(posLanes(out).y.map((p: number[]) => p[0])).toEqual([0, 1000]);
    });

    it("removes a keyframe carried by one lane only", () => {
      const base = doc({
        position: positionTrack({
          x: keys([0, 0], [1000, 100]),
          y: keys([0, 0], [400, 40], [1000, 100]),
        }),
      });
      const out = toggle(base, START + 400);
      expect(posLanes(out).y.map((p: number[]) => p[0])).toEqual([0, 1000]);
    });

    it("disarms when the last keyframe goes", () => {
      const base = doc({ position: positionTrack({ x: keys([500, 77]), y: keys([500, 88]) }) });
      const out = toggle(base, START + 500);
      expect(el(out).animation.position.isActivate).toBe(false);
      expect(posLanes(out)).toEqual({ x: [], y: [] });
    });

    /*
     * The picture must not jump on that final removal.
     *
     * A dragged position writes keyframes and never touches `location`, so the
     * static field holds the *pre-drag* place. Falling back to it would snap the
     * clip across the frame. This is the symmetric half of `setTrackActive`'s
     * seed, which exists so that arming a property is not "watch the element
     * jump" either.
     */
    it.each([
      ["position", { position: positionTrack({ x: keys([500, 777]), y: keys([500, 888]) }) }],
      ["opacity", { opacity: { isActivate: true, x: keys([500, 33]), ax: bakeTrack(keys([500, 33])) } }],
      ["rotation", { rotation: { isActivate: true, x: keys([500, 45]), ax: bakeTrack(keys([500, 45])) } }],
      ["size", { size: positionTrack({ x: keys([500, 640]), y: keys([500, 360]) }) }],
    ])("keeps the rendered %s across the last removal", (property, animation) => {
      const base = doc(animation as any);
      const at = START + 500;
      const before = localSampleAt(el(base), at);
      const after = localSampleAt(el(toggle(base, at, property)), at);
      expect(after).toEqual(before);
    });
  });

  describe("declines by identity", () => {
    const base = () =>
      doc({ position: positionTrack({ x: keys([0, 0], [1000, 100]), y: keys([0, 0], [1000, 100]) }) });

    it("when the element is missing", () => {
      const d = base();
      expect(toggleKeyframe(d, "nope", "position", START, FPS)).toBe(d);
    });

    it("when the element cannot animate that property", () => {
      const d = base();
      // A video carries no mask, so the mask's five are not on offer.
      expect(toggleKeyframe(d, "a", "maskFeather", START, FPS)).toBe(d);
    });

    it("when the track object is absent", () => {
      const d = doc({});
      expect(toggleKeyframe(d, "a", "position", START, FPS)).toBe(d);
    });

    // A keyframe outside the clip never plays, so reporting success would be a
    // lie. This is also the clamp the panels never had: they wrote
    // `cursor - startTime` raw and seeded keyframes at negative times.
    it.each([
      ["before the clip", START - 1],
      ["past the clip", START + 2000],
    ])("when the playhead is %s", (_name, cursor) => {
      const d = base();
      expect(toggleKeyframe(d, "a", "position", cursor, FPS)).toBe(d);
    });
  });
});

import { describe, it, expect } from "vitest";
import {
  MIN_SLIDE_PX,
  applyPreset,
  focusOffset,
  playheadAnchor,
  presetGroup,
  presetIsFocusable,
  presetLabel,
  presetNames,
  presetProperties,
  presetProperty,
} from "./presets";
import {
  createTrack,
  normalizeDocument,
  SCHEMA_VERSION,
} from "../timeline/tracks";
import {
  videoElement,
  gifElement,
  shapeElement,
  effectElement,
  audioElement,
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

function clip(over: any = {}) {
  return videoElement({
    trackId: "v1",
    startTime: 0,
    duration: 4_000,
    sourceDuration: 4_000,
    trim: { startTime: 0, endTime: 4_000 },
    speed: 1,
    ...over,
  });
}

/** The authored keyframes on a lane, as `[timeMs, value]` pairs. */
function laneOf(document: any, id: string, property: string) {
  const list = document.elements[id]?.animation?.[property]?.x ?? [];
  return list.map((keyframe: any) => [keyframe.p[0], keyframe.p[1]]);
}

describe("applyPreset", () => {
  it("fade_in activates opacity and writes exactly two keyframes", () => {
    const after = applyPreset(doc({ a: clip() }), "a", "fade_in", 250);

    expect(after.elements.a.animation.opacity.isActivate).toBe(true);
    expect(laneOf(after, "a", "opacity")).toEqual([
      [0, 0],
      [250, 100],
    ]);
  });

  it("fade_out is anchored to the clip's end", () => {
    // A 4000ms clip, a 250ms fade: 3750 -> 4000.
    const after = applyPreset(doc({ a: clip() }), "a", "fade_out", 250);

    expect(laneOf(after, "a", "opacity")).toEqual([
      [3_750, 100],
      [4_000, 0],
    ]);
  });

  it("zoom_in works in the tenths the scale track stores", () => {
    const after = applyPreset(doc({ a: clip() }), "a", "zoom_in", 250);

    // 10 is unscaled, 12 is 120% — `transform.ts` divides by 10.
    expect(laneOf(after, "a", "scale")).toEqual([
      [0, 10],
      [250, 12],
    ]);
  });

  it("zoom_out runs the other way", () => {
    const after = applyPreset(doc({ a: clip() }), "a", "zoom_out", 250);
    expect(laneOf(after, "a", "scale")).toEqual([
      [0, 12],
      [250, 10],
    ]);
  });

  it("clamps a preset longer than the clip rather than refusing it", () => {
    const short = doc({ a: clip({ duration: 200, sourceDuration: 200, trim: { startTime: 0, endTime: 200 } }) });
    const after = applyPreset(short, "a", "fade_in", 250);

    expect(laneOf(after, "a", "opacity")).toEqual([
      [0, 0],
      [200, 100],
    ]);
  });

  it("accounts for speed, since the span is what the viewer sees", () => {
    const fast = doc({ a: clip({ speed: 2 }) }); // 4000ms source, 2000ms span
    const after = applyPreset(fast, "a", "fade_out", 250);

    expect(laneOf(after, "a", "opacity")).toEqual([
      [1_750, 100],
      [2_000, 0],
    ]);
  });

  // ------------------------------------------------------- decline by identity

  it("returns the input by identity for a missing element", () => {
    const before = doc({ a: clip() });
    expect(applyPreset(before, "nope", "fade_in", 250)).toBe(before);
  });

  it("returns the input by identity for an unknown preset", () => {
    const before = doc({ a: clip() });
    expect(applyPreset(before, "a", "spin" as any, 250)).toBe(before);
  });

  it("returns the input by identity for a gif, which has no animation block", () => {
    const before = doc({ a: gifElement({ trackId: "v1" }) });
    expect(applyPreset(before, "a", "fade_in", 250)).toBe(before);
  });

  it("returns the input by identity for audio", () => {
    const before = doc({ a: audioElement({ trackId: "a1" }) }, [["a1", "audio"]]);
    expect(applyPreset(before, "a", "fade_in", 250)).toBe(before);
  });

  it("returns the input by identity for a scale preset on an effect", () => {
    // An effect animates opacity and nothing else. This used to be asserted of
    // a shape, which now carries the full four-track block.
    const before = doc({ a: effectElement({ trackId: "v1" }) });
    expect(applyPreset(before, "a", "zoom_in", 250)).toBe(before);
  });

  it("still fades an effect, which does animate opacity", () => {
    const before = doc({ a: effectElement({ trackId: "v1" }) });
    const after = applyPreset(before, "a", "fade_in", 250);
    expect(after).not.toBe(before);
    expect(after.elements.a.animation.opacity.isActivate).toBe(true);
  });

  it("scales and rotates a shape, which now animates all four", () => {
    const before = doc({ a: shapeElement({ trackId: "v1" }) });

    const zoomed = applyPreset(before, "a", "zoom_in", 250);
    expect(zoomed).not.toBe(before);
    expect(zoomed.elements.a.animation.scale.isActivate).toBe(true);

    const settled = applyPreset(before, "a", "rotate_settle", 250);
    expect(settled).not.toBe(before);
    expect(settled.elements.a.animation.rotation.isActivate).toBe(true);
  });
});

describe("the preset table", () => {
  it("names at least one property for every preset it offers", () => {
    for (const name of presetNames()) {
      expect(presetProperties(name).length, name).toBeGreaterThan(0);
    }
  });

  it("still answers presetProperty for the single-property ones", () => {
    expect(presetProperty("fade_in")).toBe("opacity");
    expect(presetProperty("zoom_in")).toBe("scale");
    // `pop` drives two, so there is no single answer and it says so.
    expect(presetProperty("pop")).toBeNull();
  });

  it("only marks scale-driven presets focusable", () => {
    for (const name of presetNames()) {
      if (presetIsFocusable(name)) {
        expect(presetProperties(name), name).toContain("scale");
        // Focus works by counter-animating position, so a preset that already
        // moves the clip has nowhere to put it.
        expect(presetProperties(name), name).not.toContain("position");
      }
    }
  });
});

describe("the moves that land", () => {
  const track = (document: any, property: string, lane = "x") =>
    document.elements.a.animation[property][lane];

  it("gives punch_in a curve that covers the distance immediately", () => {
    const after = applyPreset(doc({ a: clip() }), "a", "punch_in", 180);
    const list = track(after, "scale");

    expect(list).toHaveLength(2);
    expect(list[0].p[1]).toBe(10);
    expect(list[1].p[1]).toBe(11.5);
    // `snap` reaches the target value at 16% of the segment. The default
    // handles would sit at the anchor's own value, which is the soft curve.
    expect(list[0].ce[1]).toBe(11.5);
    expect(list[0].ce[0]).toBeCloseTo(180 * 0.16, 5);
  });

  it("makes drift a constant rate, not an eased one", () => {
    const after = applyPreset(doc({ a: clip() }), "a", "drift", 4_000);
    const list = track(after, "scale");
    // Linear puts the control points on the straight line between anchors.
    expect(list[0].ce).toEqual([0, 10]);
    expect(list[1].cs).toEqual([4_000, 10.8]);
  });

  it("takes overshoot_in past its target", () => {
    const after = applyPreset(doc({ a: clip() }), "a", "overshoot_in", 420);
    expect(track(after, "scale")[0].ce[1]).toBeGreaterThan(12);
  });

  it("drives both of pop's properties, or the move would be a different one", () => {
    const after = applyPreset(doc({ a: clip() }), "a", "pop", 320);
    expect(track(after, "scale")).toHaveLength(3);
    expect(track(after, "opacity")).toHaveLength(2);
    expect(after.elements.a.animation.scale.isActivate).toBe(true);
    expect(after.elements.a.animation.opacity.isActivate).toBe(true);
  });

  it("gives shake alternating sign and decaying amplitude", () => {
    const after = applyPreset(doc({ a: clip() }), "a", "shake", 300);
    const xs = track(after, "position").map((k: any) => k.p[1]);

    expect(xs[0]).toBe(0);
    expect(xs[xs.length - 1]).toBe(0);
    // Alternating: each extreme is on the other side of the last.
    expect(xs[1]).toBeLessThan(0);
    expect(xs[2]).toBeGreaterThan(0);
    expect(xs[3]).toBeLessThan(0);
    // Decaying: each swing is smaller than the one before.
    expect(Math.abs(xs[2])).toBeLessThan(Math.abs(xs[1]));
    expect(Math.abs(xs[3])).toBeLessThan(Math.abs(xs[2]));
  });

  it("writes shake as an offset from where the clip already sits", () => {
    const after = applyPreset(
      doc({ a: clip({ location: { x: 500, y: 40 } }) }),
      "a",
      "shake",
      300,
    );
    const xs = track(after, "position").map((k: any) => k.p[1]);
    expect(xs[0]).toBe(500);
    expect(xs[1]).toBe(486);
    // The untouched axis holds its own value rather than snapping to zero.
    expect(track(after, "position", "y")[1].p[1]).toBe(40);
  });

  it("rotates from an offset against the clip's own angle", () => {
    const after = applyPreset(
      doc({ a: clip({ rotation: 20 }) }),
      "a",
      "rotate_settle",
      380,
    );
    const list = track(after, "rotation");
    expect(list[0].p[1]).toBe(13);
    expect(list[1].p[1]).toBe(20);
  });

  it("scales every preset to the duration it is given", () => {
    const after = applyPreset(doc({ a: clip() }), "a", "pop", 1_000);
    const times = track(after, "scale").map((k: any) => k.p[0]);
    expect(times).toEqual([0, 550, 1_000]);
  });
});

describe("focus", () => {
  it("is a no-op at the centre, so the middle costs nothing", () => {
    expect(focusOffset({ x: 50, y: 50 }, 14, 1920, 1080)).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("pushes the clip away from the point it zooms towards", () => {
    // Zooming 2x at the right edge has to move the content left by half the
    // width, or the edge slides out of frame.
    expect(focusOffset({ x: 100, y: 50 }, 20, 1920, 1080).x).toBe(-960);
  });

  it("reverses for a zoom out", () => {
    expect(focusOffset({ x: 100, y: 50 }, 5, 1920, 1080).x).toBe(480);
  });

  it("holds the focus point exactly, by the transform's own arithmetic", () => {
    // `localMatrixOf` maps an element-local point p to x + c + s*(p - c).
    // The focus point must land in the same place unscaled and scaled.
    const width = 1920;
    const height = 1080;
    const focus = { x: 25, y: 75 };
    const px = (focus.x / 100) * width;
    const py = (focus.y / 100) * height;
    const cx = width / 2;
    const cy = height / 2;

    const at = (scaleTenths: number) => {
      const s = scaleTenths / 10;
      const offset = focusOffset(focus, scaleTenths, width, height);
      return {
        x: offset.x + cx + s * (px - cx),
        y: offset.y + cy + s * (py - cy),
      };
    };

    const unscaled = at(10);
    for (const scale of [11.5, 14, 20, 8]) {
      const moved = at(scale);
      expect(moved.x).toBeCloseTo(unscaled.x, 9);
      expect(moved.y).toBeCloseTo(unscaled.y, 9);
    }
  });

  it("writes a position track alongside the scale one", () => {
    const after = applyPreset(
      doc({ a: clip({ width: 1920, height: 1080 }) }),
      "a",
      "punch_in",
      180,
      undefined,
      { focus: { x: 20, y: 30 } },
    );

    expect(after.elements.a.animation.position.isActivate).toBe(true);
    // Same times as the scale track, so the counter-move cannot lag the zoom.
    const scaleTimes = after.elements.a.animation.scale.x.map((k: any) => k.p[0]);
    const posTimes = after.elements.a.animation.position.x.map((k: any) => k.p[0]);
    expect(posTimes).toEqual(scaleTimes);
  });

  it("leaves position alone at the centre", () => {
    const after = applyPreset(
      doc({ a: clip({ width: 1920, height: 1080, location: { x: 0, y: 0 } }) }),
      "a",
      "punch_in",
      180,
      undefined,
      { focus: { x: 50, y: 50 } },
    );
    const xs = after.elements.a.animation.position.x.map((k: any) => k.p[1]);
    expect(xs).toEqual([0, 0]);
  });

  it("is ignored by a preset that already moves the clip", () => {
    const withFocus = applyPreset(
      doc({ a: clip() }),
      "a",
      "shake",
      300,
      undefined,
      { focus: { x: 10, y: 10 } },
    );
    const without = applyPreset(doc({ a: clip() }), "a", "shake", 300);

    expect(
      withFocus.elements.a.animation.position.x.map((k: any) => k.p[1]),
    ).toEqual(without.elements.a.animation.position.x.map((k: any) => k.p[1]));
  });
});

/**
 * The playhead anchor.
 *
 * Every assertion above pins the *unanchored* path, and they are the regression
 * guard for this block: `startAtMs` is an option, so omitting it has to leave
 * `fade_in` at the clip's start and `fade_out` at its end, exactly as before.
 */
describe("startAtMs", () => {
  it("starts the preset at the anchor rather than the clip's start", () => {
    const after = applyPreset(doc({ a: clip() }), "a", "fade_in", 250, undefined, {
      startAtMs: 1_000,
    });

    expect(laneOf(after, "a", "opacity")).toEqual([
      [1_000, 0],
      [1_250, 100],
    ]);
  });

  it("overrides fromEnd, so an out preset also runs forward from the anchor", () => {
    // Without the anchor this lands at 3750 -> 4000. The playhead is the whole
    // point of the option, so it outranks the preset's own idea of where to sit.
    const after = applyPreset(doc({ a: clip() }), "a", "fade_out", 250, undefined, {
      startAtMs: 1_000,
    });

    expect(laneOf(after, "a", "opacity")).toEqual([
      [1_000, 100],
      [1_250, 0],
    ]);
  });

  it("compresses a preset that will not fit rather than moving the anchor back", () => {
    // Pulling the anchor back to 3750 would start the move somewhere the user
    // did not click. A 100ms fade at the point they asked for is the honest
    // reading of "fade in from here".
    const after = applyPreset(doc({ a: clip() }), "a", "fade_in", 250, undefined, {
      startAtMs: 3_900,
    });

    expect(laneOf(after, "a", "opacity")).toEqual([
      [3_900, 0],
      [4_000, 100],
    ]);
  });

  it("clamps an anchor past the clip's end into it", () => {
    const after = applyPreset(doc({ a: clip() }), "a", "fade_in", 250, undefined, {
      startAtMs: 9_000,
    });
    const times = laneOf(after, "a", "opacity").map(([t]: any) => t);

    expect(times[0]).toBe(3_999);
    expect(times[times.length - 1]).toBe(4_000);
  });

  it("clamps a negative anchor to the clip's start", () => {
    const after = applyPreset(doc({ a: clip() }), "a", "fade_in", 250, undefined, {
      startAtMs: -500,
    });

    expect(laneOf(after, "a", "opacity")).toEqual([
      [0, 0],
      [250, 100],
    ]);
  });

  it("anchors a multi-stop preset's whole curve, keeping its shape", () => {
    const after = applyPreset(doc({ a: clip() }), "a", "pop", 320, undefined, {
      startAtMs: 500,
    });
    const times = laneOf(after, "a", "scale").map(([t]: any) => t);

    // 0 / 0.55 / 1 of 320ms, all shifted by the anchor.
    expect(times).toEqual([500, 500 + 176, 820]);
  });

  it("leaves the unanchored path exactly where it was", () => {
    const before = doc({ a: clip() });
    expect(laneOf(applyPreset(before, "a", "fade_in", 250), "a", "opacity")).toEqual(
      laneOf(
        applyPreset(before, "a", "fade_in", 250, undefined, {}),
        "a",
        "opacity",
      ),
    );
  });
});

describe("playheadAnchor", () => {
  it("answers the element-local time when the cursor is over the clip", () => {
    expect(playheadAnchor(clip({ startTime: 1_000 }), 2_500)).toBe(1_500);
  });

  it("answers 0 at the clip's own start", () => {
    expect(playheadAnchor(clip({ startTime: 1_000 }), 1_000)).toBe(0);
  });

  it("declines before the clip", () => {
    expect(playheadAnchor(clip({ startTime: 1_000 }), 500)).toBeUndefined();
  });

  it("declines at and past the clip's end, which is a half-open span", () => {
    // [1000, 5000): the last instant the clip covers is 4999.
    expect(playheadAnchor(clip({ startTime: 1_000 }), 5_000)).toBeUndefined();
    expect(playheadAnchor(clip({ startTime: 1_000 }), 9_000)).toBeUndefined();
    expect(playheadAnchor(clip({ startTime: 1_000 }), 4_999)).toBe(3_999);
  });

  it("uses the span the viewer sees, so speed is accounted for", () => {
    // 4000ms of source at 2x is 2000ms on the timeline.
    const fast = clip({ startTime: 1_000, speed: 2 });
    expect(playheadAnchor(fast, 2_500)).toBe(1_500);
    expect(playheadAnchor(fast, 3_500)).toBeUndefined();
  });

  it("declines for nothing at all", () => {
    expect(playheadAnchor(null, 0)).toBeUndefined();
    expect(playheadAnchor(undefined, 0)).toBeUndefined();
  });
});

describe("the directional slides", () => {
  /**
   * Every slide, and which way its value runs.
   *
   * Canvas x grows rightward and y grows downward, so travelling *up* or *left*
   * means the value falls. A sign flip in one of the eight is the failure this
   * table exists to catch, and it is invisible from the preset's name alone.
   */
  const DIRECTIONS = [
    ["slide_in_up", "y", "falls"],
    ["slide_in_down", "y", "rises"],
    ["slide_in_left", "x", "falls"],
    ["slide_in_right", "x", "rises"],
    ["slide_out_up", "y", "falls"],
    ["slide_out_down", "y", "rises"],
    ["slide_out_left", "x", "falls"],
    ["slide_out_right", "x", "rises"],
  ] as const;

  it("travels the direction its name claims", () => {
    for (const [preset, lane, direction] of DIRECTIONS) {
      const after = applyPreset(doc({ a: clip() }), "a", preset, 420);
      const values = after.elements.a.animation.position[lane].map(
        (k: any) => k.p[1],
      );
      const first = values[0];
      const last = values[values.length - 1];

      if (direction === "falls") {
        expect(first, preset).toBeGreaterThan(last);
      } else {
        expect(first, preset).toBeLessThan(last);
      }
    }
  });

  it("comes to rest at the clip's own position, in and out alike", () => {
    for (const [preset] of DIRECTIONS) {
      const after = applyPreset(
        doc({ a: clip({ location: { x: 300, y: 200 } }) }),
        "a",
        preset,
        420,
      );
      const xs = after.elements.a.animation.position.x.map((k: any) => k.p[1]);
      const ys = after.elements.a.animation.position.y.map((k: any) => k.p[1]);
      const rest = preset.startsWith("slide_in_") ? "last" : "first";
      const at = (list: number[]) => (rest === "last" ? list[list.length - 1] : list[0]);

      expect(at(xs), preset).toBe(300);
      expect(at(ys), preset).toBe(200);
    }
  });

  it("fades as well as moves, in every direction", () => {
    // A move with no fade slides an opaque title in from off-screen, or cuts one
    // off mid-flight. Premiere's and Final Cut's own slides pair the two.
    for (const [preset] of DIRECTIONS) {
      expect(presetProperties(preset), preset).toContain("position");
      expect(presetProperties(preset), preset).toContain("opacity");
    }
  });

  it("measures the distance in the element's own box, not in pixels", () => {
    const wide = applyPreset(
      doc({ a: clip({ width: 800, height: 400 }) }),
      "a",
      "slide_in_up",
      420,
    );
    const ys = wide.elements.a.animation.position.y.map((k: any) => k.p[1]);
    // One box-height below its resting place.
    expect(ys[0] - ys[ys.length - 1]).toBe(400);
  });

  it("floors the distance so a zero-height element still moves", () => {
    const flat = applyPreset(
      doc({ a: clip({ width: 0, height: 0 }) }),
      "a",
      "slide_in_up",
      420,
    );
    const ys = flat.elements.a.animation.position.y.map((k: any) => k.p[1]);
    expect(ys[0] - ys[ys.length - 1]).toBe(MIN_SLIDE_PX);
  });

  it("leaves shake in absolute pixels, which is what a rattle is", () => {
    const big = applyPreset(
      doc({ a: clip({ width: 1920, height: 1080 }) }),
      "a",
      "shake",
      300,
    );
    expect(big.elements.a.animation.position.x[1].p[1]).toBe(-14);
  });

  // ------------------------------------------------------- decline by identity

  it("returns the input by identity for a gif", () => {
    const before = doc({ a: gifElement({ trackId: "v1" }) });
    expect(applyPreset(before, "a", "slide_in_up", 420)).toBe(before);
  });

  it("returns the input by identity for an effect, which cannot move", () => {
    const before = doc({ a: effectElement({ trackId: "v1" }) });
    expect(applyPreset(before, "a", "slide_in_up", 420)).toBe(before);
  });
});

describe("preset metadata", () => {
  it("labels every preset it offers", () => {
    for (const name of presetNames()) {
      expect(presetLabel(name), name).toBeTruthy();
    }
  });

  it("gives every preset a distinct label, or the grid is unreadable", () => {
    const labels = presetNames().map(presetLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("groups every preset", () => {
    for (const name of presetNames()) {
      expect(["in", "out", "emphasis"], name).toContain(presetGroup(name));
    }
  });

  it("puts the anchored-to-the-end presets in the out group", () => {
    // Not a naming rule: `fromEnd` is what the preset does when nobody anchors
    // it, and that is the same question the group answers.
    expect(presetGroup("fade_out")).toBe("out");
    expect(presetGroup("slide_out_up")).toBe("out");
    expect(presetGroup("fade_in")).toBe("in");
    expect(presetGroup("shake")).toBe("emphasis");
  });
});

describe("bake rate", () => {
  // The bug this guards: every authoring path took `bakeTrack`'s 60Hz default,
  // so in a 120fps project a preset was baked at half the project's rate and
  // handed consecutive frames the same value until the file was reloaded.
  const samplesOf = (document: any) => document.elements.a.animation.opacity.ax;

  it("bakes at the default 60Hz when no rate is given", () => {
    const after = applyPreset(doc({ a: clip() }), "a", "fade_in", 1_000);
    // A one-second fade at 60Hz: 61 samples, endpoints included.
    expect(samplesOf(after)).toHaveLength(61);
  });

  it("bakes at the project's rate when it is higher", () => {
    const after = applyPreset(doc({ a: clip() }), "a", "fade_in", 1_000, 120);
    expect(samplesOf(after)).toHaveLength(121);
  });

  it("does not coarsen below 60Hz for a slower project", () => {
    // `bakeRateFor` is max(60, fps), so a caller passing 60 for a 24fps project
    // gets the floor — the lane is a cache, and a coarser one would step.
    const after = applyPreset(doc({ a: clip() }), "a", "fade_in", 1_000, 60);
    expect(samplesOf(after)).toHaveLength(61);
  });
});

import { describe, it, expect } from "vitest";
import { keyframeNavAt, keyframeTimesOf } from "./keyframeNav";
import { bakeTrack } from "./keyframes";

const FPS = 60;

/** A keyframe list from `[t, value]` pairs, handles flat. */
const keys = (...pairs: Array<[number, number]>) =>
  pairs.map(([t, v]) => ({
    type: "cubic" as const,
    p: [t, v] as [number, number],
    cs: [t, v] as [number, number],
    ce: [t, v] as [number, number],
  }));

const track = (over: Record<string, any> = {}) => {
  const x = over.x ?? [];
  const y = over.y ?? [];
  return {
    isActivate: true,
    x,
    y,
    ax: bakeTrack(x),
    ay: bakeTrack(y),
    ...over,
  };
};

const clip = (animation: Record<string, any>, over: Record<string, any> = {}) =>
  ({
    filetype: "video",
    startTime: 1000,
    duration: 2000,
    location: { x: 0, y: 0 },
    width: 100,
    height: 100,
    opacity: 100,
    rotation: 0,
    animation,
    ...over,
  }) as any;

describe("keyframeNavAt", () => {
  const positioned = (...pairs: Array<[number, number]>) =>
    clip({
      position: track({ x: keys(...pairs), y: keys(...pairs) }),
    });

  it("is off when the track is switched off", () => {
    const el = clip({
      position: track({ x: keys([0, 1]), y: keys([0, 2]), isActivate: false }),
    });
    expect(keyframeNavAt(el, "position", 1000, FPS).mark).toBe("off");
  });

  // An armed track with no curve renders from the static value, so calling it
  // armed would light the diamond for an animation nobody can see.
  it("is off when the track is armed but empty", () => {
    const el = clip({ position: track() });
    expect(keyframeNavAt(el, "position", 1000, FPS).mark).toBe("off");
  });

  it("is on at a keyframe and empty between two", () => {
    const el = positioned([0, 0], [1000, 50]);
    // startTime is 1000, so cursor 1000 is element-local 0.
    expect(keyframeNavAt(el, "position", 1000, FPS).mark).toBe("on");
    expect(keyframeNavAt(el, "position", 1500, FPS).mark).toBe("empty");
    expect(keyframeNavAt(el, "position", 2000, FPS).mark).toBe("on");
  });

  it("reports the stored time, not the playhead", () => {
    const el = positioned([0, 0], [500, 50]);
    // 508ms is inside frame 30 (500-516.7ms at 60fps) but is not the stored time.
    const nav = keyframeNavAt(el, "position", 1508, FPS);
    expect(nav.mark).toBe("on");
    expect(nav.atMs).toBe(500);
  });

  // The whole reason for frame matching rather than a 2ms tolerance: a
  // keyframe a few ms off the grid is on screen for the same frame, so a
  // click must remove it rather than plant a second one beside it.
  it("counts an off-grid keyframe on the playhead's frame", () => {
    const el = positioned([0, 0], [505, 50]);
    const nav = keyframeNavAt(el, "position", 1500, FPS);
    expect(nav.mark).toBe("on");
    expect(nav.atMs).toBe(505);
  });

  it("finds the neighbours and reports null at the ends", () => {
    const el = positioned([0, 0], [500, 25], [1000, 50]);
    const middle = keyframeNavAt(el, "position", 1500, FPS);
    expect([middle.prevMs, middle.nextMs]).toEqual([0, 1000]);

    const first = keyframeNavAt(el, "position", 1000, FPS);
    expect([first.prevMs, first.nextMs]).toEqual([null, 500]);

    const last = keyframeNavAt(el, "position", 2000, FPS);
    expect([last.prevMs, last.nextMs]).toEqual([500, null]);
  });

  // A keyframe outside the clip never plays, so nothing can be keyed there.
  it("reports inSpan false off either end of the clip", () => {
    const el = positioned([0, 0], [1000, 50]);
    expect(keyframeNavAt(el, "position", 999, FPS).inSpan).toBe(false);
    expect(keyframeNavAt(el, "position", 1000, FPS).inSpan).toBe(true);
    // Half-open: the clip occupies [start, start + length).
    expect(keyframeNavAt(el, "position", 2999, FPS).inSpan).toBe(true);
    expect(keyframeNavAt(el, "position", 3000, FPS).inSpan).toBe(false);
  });

  it("takes speed into account, not raw duration", () => {
    const el = clip(
      { position: track({ x: keys([0, 0]), y: keys([0, 0]) }) },
      { filetype: "video", speed: 2, trim: { startTime: 0, endTime: 2000 } },
    );
    // 2000ms of source at 2x occupies 1000ms of timeline.
    expect(keyframeNavAt(el, "position", 2500, FPS).inSpan).toBe(false);
  });

  it("declines for a property this element cannot animate", () => {
    const el = clip({ position: track({ x: keys([0, 0]) }) });
    expect(keyframeNavAt(el, "maskFeather", 1000, FPS).mark).toBe("off");
  });
});

describe("keyframeTimesOf", () => {
  it("dedupes the two lanes of a paired property", () => {
    const el = clip({
      position: track({ x: keys([0, 0], [500, 1]), y: keys([0, 0], [500, 2]) }),
    });
    // `keyframeMarkers.keyframeTimes` would report each instant twice; one
    // arrow press has to be one keyframe.
    expect(keyframeTimesOf(el, "position")).toEqual([0, 500]);
  });

  // Projects authored before `addKeyframePaired` existed can have lanes of
  // different lengths, so the union still matters.
  it("unions lanes that disagree", () => {
    const el = clip({
      position: track({ x: keys([0, 0], [500, 1]), y: keys([0, 0], [900, 2]) }),
    });
    expect(keyframeTimesOf(el, "position")).toEqual([0, 500, 900]);
  });

  it("reads only the named property's own lanes", () => {
    const el = clip({
      position: track({ x: keys([0, 0]), y: keys([0, 0]) }),
      opacity: track({ x: keys([700, 50]) }),
    });
    expect(keyframeTimesOf(el, "opacity")).toEqual([700]);
  });
});

/**
 * A zoom holds the point it was aimed at.
 *
 * The user-visible symptom this pins: "확대했다 축소하면 안 맞물린다" — building a
 * punch-in on a screen recording by keyframing `position` and `size` together
 * gave a move that only lined up at its two ends and drifted in between.
 *
 * The geometry says it should line up everywhere. With no rotation and unit
 * scale a clip's box is `[x, x + w)`, so a source point at normalised `u` lands
 * at `x + u·w`, and holding it at `C` means
 *
 *     x(t) = C − u·w(t)
 *
 * — `x` is an *affine function of* `w`. So if both tracks carry the same
 * keyframe instants and the same normalised curve, the identity holds at every
 * sample, not just at the anchors. There is nothing approximate about it.
 *
 * Which makes the drift a bug rather than a limitation, and it was: the two
 * lanes did *not* get the same curve. `addKeyframePaired` planted the sibling
 * lane's new endpoint with its handles collapsed onto the anchor, so a dragged
 * `position` came out eased on x and linear on y. This suite authors a zoom
 * both ways a user can — the sidebar's number fields and a preview drag — and
 * asserts the aimed-at point does not move.
 */
import { describe, it, expect } from "vitest";
import { addKeyframe, addKeyframePaired, setTrackActive } from "./keyframeOps";
import { localSampleAt } from "../timeline/transform";
import {
  SCHEMA_VERSION,
  createTrack,
  type TimelineDocument,
} from "../timeline/tracks";
import { emptyAnimation } from "./keyframes";

const W = 1920;
const H = 1080;
const SPAN = 1000;

/** The point being zoomed towards, as a fraction of the clip's own box. */
const U = 0.75;
const V = 0.25;

/** Where that point sits on screen at the start — and must stay. */
const FOCUS = { x: U * W, y: V * H };

const clip = (): TimelineDocument => ({
  schemaVersion: SCHEMA_VERSION,
  tracks: [createTrack("v1", "video", 0)],
  elements: {
    a: {
      filetype: "video",
      startTime: 0,
      duration: SPAN,
      location: { x: 0, y: 0 },
      width: W,
      height: H,
      opacity: 100,
      rotation: 0,
      animation: emptyAnimation("video"),
    } as any,
  },
});

/** The end pose of a 2x zoom that keeps `FOCUS` still. */
const END = {
  w: W * 2,
  h: H * 2,
  x: FOCUS.x - U * W * 2,
  y: FOCUS.y - V * H * 2,
};

/** Turn both tracks on, seeded at the clip's start from the static box. */
const armed = () => {
  let d = setTrackActive(clip(), "a", "size", true, { atMs: 0 });
  return setTrackActive(d, "a", "position", true, { atMs: 0 });
};

/** The size half, as the sidebar's Width/Height fields write it. */
const withSize = (d: TimelineDocument) =>
  addKeyframe(
    addKeyframe(d, "a", "size", "x", SPAN, END.w),
    "a",
    "size",
    "y",
    SPAN,
    END.h,
  );

/** Where the aimed-at point actually lands at `t`. */
const focusAt = (d: TimelineDocument, t: number) => {
  const s = localSampleAt(d.elements.a, t);
  return { x: s.x + U * s.width, y: s.y + V * s.height };
};

describe("a position + size zoom holds its focus point", () => {
  /** Every frame of a 60fps second, plus the anchors. */
  const CURSORS = Array.from({ length: 61 }, (_, i) => (i / 60) * SPAN);

  const expectHeld = (d: TimelineDocument) => {
    for (const t of CURSORS) {
      const at = focusAt(d, t);
      // One pixel of a 1920-wide frame. The residual is the baked lane's own
      // sampling grain, not a drift: it does not grow across the move.
      expect(at.x).toBeCloseTo(FOCUS.x, 0);
      expect(at.y).toBeCloseTo(FOCUS.y, 0);
    }
  };

  it("holds it when position is typed into the sidebar", () => {
    let d = withSize(armed());
    d = addKeyframe(d, "a", "position", "x", SPAN, END.x);
    d = addKeyframe(d, "a", "position", "y", SPAN, END.y);
    expectHeld(d);
  });

  // The route that was broken: `previewCanvas` drags both lanes through
  // `addKeyframePaired`, one call each, in one gesture.
  it("holds it when position is dragged on the preview", () => {
    let d = withSize(armed());
    d = addKeyframePaired(d, "a", "position", "x", SPAN, END.x);
    d = addKeyframePaired(d, "a", "position", "y", SPAN, END.y);
    expectHeld(d);
  });

  // Zoom in, hold, zoom back out — the shape the user actually asked about.
  it("holds it across a zoom in, a hold, and a zoom out", () => {
    let d = armed();
    for (const [t, w, h] of [
      [300, END.w, END.h],
      [700, END.w, END.h],
      [1000, W, H],
    ] as const) {
      d = addKeyframe(d, "a", "size", "x", t, w);
      d = addKeyframe(d, "a", "size", "y", t, h);
    }
    for (const [t, x, y] of [
      [300, END.x, END.y],
      [700, END.x, END.y],
      [1000, 0, 0],
    ] as const) {
      d = addKeyframePaired(d, "a", "position", "x", t, x);
      d = addKeyframePaired(d, "a", "position", "y", t, y);
    }
    expectHeld(d);
  });
});

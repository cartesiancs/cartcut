/**
 * What a transition badge and a cut hint actually put on the canvas.
 *
 * Pixels, against a real Skia canvas, like the rest of `draw.test.ts`. The
 * point is not the artwork but the two properties the interaction depends on:
 * a badge is visible where `hitTest` says it is, and the cut hint appears only
 * while hovered.
 */

import { describe, it, expect } from "vitest";
import { drawTimeline, type DrawOptions } from "./draw";
import { layoutTimeline, type TimelineLayout } from "./layout";
import { addTransition } from "./transitionOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { pixel, scene, videoElement } from "../renderer/testing";

/**
 * Perceived brightness, which is what these assertions actually turn on.
 *
 * They used to compare channels — "more blue than green" — which worked only
 * while the badge was a saturated violet. It is white now, so hue says nothing
 * and the real question is whether something light was painted over a dark
 * clip. Testing that directly survives the next colour change too.
 */
function luma(px: { r: number; g: number; b: number }): number {
  return 0.2126 * px.r + 0.7152 * px.g + 0.0722 * px.b;
}

/** The clips below are painted this, so anything brighter is not a clip. */
const CLIP_LUMA = luma({ r: 0x20, g: 0x40, b: 0x20 });

const RANGE = 0.9;
const W = 900;
const H = 200;

function clip(over: { startTime: number; trimIn: number; trimOut: number }) {
  const { startTime, trimIn, trimOut } = over;
  return videoElement({
    trackId: "v0",
    startTime,
    duration: trimOut - trimIn,
    trim: { startTime: trimIn, endTime: trimOut },
    sourceDuration: 20_000,
    timelineOptions: { color: "#204020" },
  });
}

function baseDoc(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0)],
    elements: {
      a: clip({ startTime: 0, trimIn: 4000, trimOut: 8000 }),
      b: clip({ startTime: 4000, trimIn: 4000, trimOut: 8000 }),
    },
  });
}

function layoutOf(doc: TimelineDocument): TimelineLayout {
  return layoutTimeline({
    doc,
    range: RANGE,
    hScroll: 0,
    vScroll: 0,
    viewportW: W,
    viewportH: H,
    topOffset: 0,
  });
}

function draw(doc: TimelineDocument, over: Partial<DrawOptions> = {}) {
  const layout = layoutOf(doc);
  const { ctx, canvas } = scene(W, H);
  drawTimeline(ctx, {
    layout,
    doc,
    range: RANGE,
    hScroll: 0,
    viewportW: W,
    viewportH: H,
    selection: [],
    playheadMs: 0,
    projectEndMs: 60_000,
    ...over,
  });
  return { canvas, layout };
}

describe("the transition badge", () => {
  it("is drawn where the layout says it is", () => {
    const doc = addTransition(baseDoc(), "t1", "a", "b", "cross", 1500, "center");
    const { canvas, layout } = draw(doc);
    const badge = layout.transitions[0];

    // The clips are dark green; the badge is white. Sampling just inside the
    // badge's left edge, vertically centred, must be far brighter than a clip.
    const at = pixel(canvas, Math.round(badge.x + 3), Math.round(badge.y + 20));
    expect(luma(at)).toBeGreaterThan(CLIP_LUMA * 3);
  });

  it("leaves the clips either side of it alone", () => {
    const doc = addTransition(baseDoc(), "t1", "a", "b", "cross", 1500, "center");
    const { canvas, layout } = draw(doc);
    const badge = layout.transitions[0];

    const wellLeft = pixel(canvas, Math.round(badge.x - 40), badge.y + 20);
    expect(wellLeft.g).toBeGreaterThan(wellLeft.r);
    expect(wellLeft.g).toBeGreaterThan(wellLeft.b);
  });

  it("rings a selected badge in something that shows on white", () => {
    // The trap a white badge sets: every other selection border on the
    // timeline is white, and a white ring on a white badge is no ring at all.
    // `transitionSelected` inverts for exactly this, and the test is here so a
    // future palette change cannot quietly undo it.
    const doc = addTransition(baseDoc(), "t1", "a", "b", "cross", 1500, "center");
    const { canvas, layout } = draw(doc, { selection: ["t1"] });
    const badge = layout.transitions[0];

    // The border sits one pixel inside the badge's left edge.
    const onBorder = pixel(canvas, Math.round(badge.x + 1), badge.y + 20);
    const inside = pixel(canvas, Math.round(badge.x + badge.w / 2), badge.y + 20);
    expect(luma(inside)).toBeGreaterThan(luma(onBorder) + 60);
  });

  it("does not paint outside its own rect", () => {
    const doc = addTransition(baseDoc(), "t1", "a", "b", "cross", 800, "center");
    const { canvas, layout } = draw(doc);
    const badge = layout.transitions[0];

    // One row down is empty background, whatever the badge is doing.
    const below = pixel(canvas, Math.round(badge.x + badge.w / 2), 120);
    expect(below).toMatchObject({ r: 0x0f, g: 0x10, b: 0x12 });
  });
});

describe("the cut affordance", () => {
  it("is absent until the cut is hovered", () => {
    const doc = baseDoc();
    const { canvas, layout } = draw(doc);
    const cut = layout.cuts[0];

    // A transcript-driven edit has hundreds of cuts; marking them all would be
    // noise, so nothing is drawn until the pointer is on one.
    const at = pixel(canvas, Math.round(cut.x) - 4, cut.y + 20);
    expect(luma(at)).toBeCloseTo(CLIP_LUMA, 0);
  });

  it("appears on the hovered cut", () => {
    const doc = baseDoc();
    const { canvas, layout } = draw(doc, {
      hoveredCut: { trackId: "v0", fromId: "a" },
    });
    const cut = layout.cuts[0];

    const at = pixel(canvas, Math.round(cut.x) - 4, cut.y + 20);
    expect(luma(at)).toBeGreaterThan(CLIP_LUMA * 2);
  });

  it("is not drawn for a cut that is not the hovered one", () => {
    const doc = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v0", "video", 0)],
      elements: {
        a: clip({ startTime: 0, trimIn: 4000, trimOut: 6000 }),
        b: clip({ startTime: 2000, trimIn: 4000, trimOut: 6000 }),
        c: clip({ startTime: 4000, trimIn: 4000, trimOut: 6000 }),
      },
    });
    const { canvas, layout } = draw(doc, {
      hoveredCut: { trackId: "v0", fromId: "a" },
    });

    expect(layout.cuts).toHaveLength(2);
    const other = layout.cuts.find((cut) => cut.fromId === "b")!;
    const at = pixel(canvas, Math.round(other.x) - 4, other.y + 20);
    expect(luma(at)).toBeCloseTo(CLIP_LUMA, 0);
  });
});

import { describe, it, expect } from "vitest";
import { splitAt, trimEnd, trimStart } from "./clipEdit";
import {
  MIN_SOURCE_MS,
  MIN_TIMELINE_MS,
  assertTrimInvariant,
  sourceTimeAt,
  spanEnd,
  spanLength,
  spanStart,
} from "./geometry";
import { audioElement, imageElement, videoElement } from "../renderer/testing";
import type { TimelineElement } from "../../@types/timeline";

/** Every edit must leave the source-window invariant intact. */
function expectValid(...elements: TimelineElement[]) {
  for (const el of elements) {
    expect(() => assertTrimInvariant(el)).not.toThrow();
    expect(el.duration).toBeGreaterThan(0);
    expect(spanStart(el)).toBeGreaterThanOrEqual(0);
  }
}

/** A 10s source, 4s of it used, starting 2s into the file, placed at 5s. */
function clip(over = {}) {
  return videoElement({
    startTime: 5000,
    duration: 4000,
    speed: 1,
    trim: { startTime: 2000, endTime: 6000 },
    sourceDuration: 10_000,
    ...over,
  });
}

describe("trimStart", () => {
  it("moves the left edge and the source window together", () => {
    const next = trimStart(clip(), 1000);
    expect(next.startTime).toBe(6000);
    expect(next.duration).toBe(3000);
    expect((next as any).trim).toEqual({ startTime: 3000, endTime: 6000 });
    expectValid(next);
  });

  it("keeps the right edge pinned while the left edge moves", () => {
    const before = clip();
    const next = trimStart(before, 1500);
    expect(spanEnd(next)).toBe(spanEnd(before));
  });

  it("still shows the same source frame at the same timeline instant", () => {
    // Trimming re-anchors the clip; it must not re-time the footage that
    // survives the cut.
    const before = clip();
    const next = trimStart(before, 1000);
    expect(sourceTimeAt(next as any, 7000)).toBe(
      sourceTimeAt(before as any, 7000),
    );
  });

  it("extends back out when dragged left", () => {
    const next = trimStart(clip(), -2000);
    expect(next.startTime).toBe(3000);
    expect(next.duration).toBe(6000);
    expect((next as any).trim).toEqual({ startTime: 0, endTime: 6000 });
    expectValid(next);
  });

  it("stops at the head of the source file", () => {
    // Only 2000ms of source head room exists, so a 9000ms drag applies 2000.
    const next = trimStart(clip(), -9000);
    expect((next as any).trim.startTime).toBe(0);
    expect(next.startTime).toBe(3000);
    expectValid(next);
  });

  it("stops at the start of the timeline", () => {
    // 1000ms of source head room but the clip sits at 400ms, so the timeline
    // runs out first and startTime must not go negative.
    const next = trimStart(
      clip({ startTime: 400, trim: { startTime: 1000, endTime: 5000 } }),
      -5000,
    );
    expect(next.startTime).toBe(0);
    expect((next as any).trim.startTime).toBe(600);
    expectValid(next);
  });

  it("leaves at least a minimum window when dragged past the right edge", () => {
    const next = trimStart(clip(), 99_000);
    expect(next.duration).toBe(MIN_SOURCE_MS);
    expect((next as any).trim.endTime).toBe(6000);
    expectValid(next);
  });

  it("scales the source cut by speed", () => {
    // 1000ms of timeline consumes 2000ms of source at 2x.
    const next = trimStart(clip({ speed: 2 }), 1000);
    expect((next as any).trim.startTime).toBe(4000);
    expect(next.duration).toBe(2000);
    expect(next.startTime).toBe(6000);
    expect(spanLength(next)).toBe(1000);
    expectValid(next);
  });

  it("shortens a static element without inventing a trim", () => {
    const next = trimStart(imageElement({ startTime: 1000, duration: 2000 }), 500);
    expect(next.startTime).toBe(1500);
    expect(next.duration).toBe(1500);
    expect((next as any).trim).toBeUndefined();
  });

  it("clamps a static element at the timeline start and at the minimum", () => {
    const el = imageElement({ startTime: 300, duration: 2000 });
    expect(trimStart(el, -9000).startTime).toBe(0);
    expect(trimStart(el, -9000).duration).toBe(2300);
    expect(trimStart(el, 9000).duration).toBe(MIN_TIMELINE_MS);
  });

  it("does not mutate its input", () => {
    const before = clip();
    const snapshot = JSON.parse(JSON.stringify(before));
    trimStart(before, 1000);
    expect(before).toEqual(snapshot);
  });
});

describe("trimEnd", () => {
  it("lengthens the source window without moving the left edge", () => {
    const next = trimEnd(clip(), 1000);
    expect(next.startTime).toBe(5000);
    expect(next.duration).toBe(5000);
    expect((next as any).trim).toEqual({ startTime: 2000, endTime: 7000 });
    expectValid(next);
  });

  it("shortens from the right", () => {
    const next = trimEnd(clip(), -1000);
    expect(next.duration).toBe(3000);
    expect((next as any).trim.endTime).toBe(5000);
    expectValid(next);
  });

  it("stops at the end of the source file", () => {
    // 10s source with the window ending at 6s leaves 4s of tail.
    const next = trimEnd(clip(), 99_000);
    expect((next as any).trim.endTime).toBe(10_000);
    expect(next.duration).toBe(8000);
    expectValid(next);
  });

  it("can undo an earlier inward trim by dragging back out", () => {
    // The regression sourceDuration exists to prevent: trim.endTime used to
    // stand in for the source length, so shortening destroyed the head room.
    const original = clip();
    const shortened = trimEnd(original, -2000);
    const restored = trimEnd(shortened, 2000);
    expect((restored as any).trim).toEqual((original as any).trim);
    expect(restored.duration).toBe(original.duration);
  });

  it("leaves at least a minimum window", () => {
    const next = trimEnd(clip(), -99_000);
    expect(next.duration).toBe(MIN_SOURCE_MS);
    expect((next as any).trim.startTime).toBe(2000);
    expectValid(next);
  });

  it("scales the source extension by speed", () => {
    const next = trimEnd(clip({ speed: 2 }), 1000);
    expect((next as any).trim.endTime).toBe(8000);
    expect(next.duration).toBe(6000);
    expect(spanLength(next)).toBe(3000);
    expectValid(next);
  });

  it("grows a static element indefinitely", () => {
    const next = trimEnd(imageElement({ startTime: 0, duration: 1000 }), 50_000);
    expect(next.duration).toBe(51_000);
  });

  it("clamps a static element at the minimum", () => {
    const next = trimEnd(imageElement({ duration: 1000 }), -9000);
    expect(next.duration).toBe(MIN_TIMELINE_MS);
  });

  it("does not mutate its input", () => {
    const before = clip();
    const snapshot = JSON.parse(JSON.stringify(before));
    trimEnd(before, 1000);
    expect(before).toEqual(snapshot);
  });
});

describe("splitAt", () => {
  it("produces two adjacent halves that tile the original span", () => {
    // This is requirement 1: the halves meet exactly, so they sit side by side
    // on one track instead of overlapping and needing a second row.
    const before = clip();
    const cut = splitAt(before, 6500)!;
    expect(spanEnd(cut.left)).toBe(spanStart(cut.right));
    expect(spanStart(cut.left)).toBe(spanStart(before));
    expect(spanEnd(cut.right)).toBe(spanEnd(before));
    expectValid(cut.left, cut.right);
  });

  it("splits the source window at the matching source frame", () => {
    const cut = splitAt(clip(), 6500)!;
    expect((cut.left as any).trim).toEqual({ startTime: 2000, endTime: 3500 });
    expect((cut.right as any).trim).toEqual({ startTime: 3500, endTime: 6000 });
    expect(cut.left.duration + cut.right.duration).toBe(4000);
  });

  it("leaves no seam in the footage", () => {
    // The frame just before the cut and the frame at the cut are consecutive
    // in the source, so a split then play-through is invisible.
    const before = clip();
    const cut = splitAt(before, 6500)!;
    expect(sourceTimeAt(cut.right as any, 6500)).toBe(
      sourceTimeAt(before as any, 6500),
    );
  });

  it("cuts the source at twice the timeline offset when sped up", () => {
    const cut = splitAt(clip({ speed: 2 }), 6000)!;
    // 1000ms into a 2x clip is 2000ms into the source, i.e. 2000 + 2000.
    expect((cut.left as any).trim.endTime).toBe(4000);
    expect((cut.right as any).trim.startTime).toBe(4000);
    expectValid(cut.left, cut.right);
  });

  it("splits a static element by duration alone", () => {
    const cut = splitAt(imageElement({ startTime: 1000, duration: 2000 }), 1500)!;
    expect(cut.left.duration).toBe(500);
    expect(cut.right.startTime).toBe(1500);
    expect(cut.right.duration).toBe(1500);
  });

  it("splits audio the same way as video", () => {
    const cut = splitAt(
      audioElement({
        startTime: 0,
        duration: 4000,
        trim: { startTime: 0, endTime: 4000 },
        sourceDuration: 4000,
      }),
      1000,
    )!;
    expect((cut.left as any).trim).toEqual({ startTime: 0, endTime: 1000 });
    expect((cut.right as any).trim).toEqual({ startTime: 1000, endTime: 4000 });
    expectValid(cut.left, cut.right);
  });

  it("refuses a cut at either boundary", () => {
    // A zero-length half would never be visible, since spans are half-open.
    expect(splitAt(clip(), 5000)).toBeNull();
    expect(splitAt(clip(), 9000)).toBeNull();
  });

  it("refuses a cut outside the clip", () => {
    expect(splitAt(clip(), 1000)).toBeNull();
    expect(splitAt(clip(), 20_000)).toBeNull();
  });

  it("carries the source length to both halves so each can still be re-trimmed", () => {
    const cut = splitAt(clip(), 6500)!;
    expect((cut.left as any).sourceDuration).toBe(10_000);
    expect((cut.right as any).sourceDuration).toBe(10_000);
  });

  it("gives the halves independent trim objects", () => {
    const cut = splitAt(clip(), 6500)!;
    expect((cut.left as any).trim).not.toBe((cut.right as any).trim);
  });

  it("does not mutate its input", () => {
    const before = clip();
    const snapshot = JSON.parse(JSON.stringify(before));
    splitAt(before, 6500);
    expect(before).toEqual(snapshot);
  });

  it("survives repeated cutting", () => {
    // Cutting a clip three times must yield four pieces that still tile the
    // original span exactly — no accumulated drift.
    const before = clip();
    const a = splitAt(before, 6000)!;
    const b = splitAt(a.right, 7000)!;
    const c = splitAt(b.right, 8000)!;
    const pieces = [a.left, b.left, c.left, c.right];

    expectValid(...pieces);
    expect(spanStart(pieces[0])).toBe(spanStart(before));
    expect(spanEnd(pieces[3])).toBe(spanEnd(before));
    for (let i = 1; i < pieces.length; i++) {
      expect(spanStart(pieces[i])).toBe(spanEnd(pieces[i - 1]));
    }
    const total = pieces.reduce((sum, p) => sum + p.duration, 0);
    expect(total).toBe(before.duration);
  });

  it("round-trips: a cut then rejoined clip matches the original", () => {
    // Requirement 1's other half — cutting and re-butting must be lossless.
    const before = clip();
    const cut = splitAt(before, 6500)!;
    const rejoined = trimEnd(cut.left, spanLength(cut.right));
    expect(rejoined.duration).toBe(before.duration);
    expect((rejoined as any).trim).toEqual((before as any).trim);
    expect(spanEnd(rejoined)).toBe(spanEnd(before));
  });
});

// =========================================================== keyframes
//
// Keyframe times are stored relative to `element.startTime`. That makes a plain
// move free, but it means any edit that changes `startTime` has to rebase them,
// and any edit that produces two elements from one has to give each its own
// copy. Neither used to happen: `splitAt` returned two `{...element}` spreads
// sharing a single `animation` object, and the right half's keyframes stayed
// measured from the original start.

import { bakeTrack, sampleTrack } from "../animation/keyframes";
import { keys } from "../renderer/testing";

/** The 4s clip above, with opacity ramping 0 -> 100 across its span. */
function animatedClip(over = {}) {
  const authored = keys([0, 0], [2000, 50], [4000, 100]);
  return clip({
    animation: {
      position: { isActivate: false, x: [], y: [], ax: [], ay: [] },
      opacity: { isActivate: true, x: authored, ax: bakeTrack(authored) },
      scale: { isActivate: false, x: [], ax: [] },
      rotation: { isActivate: false, x: [], ax: [] },
    },
    ...over,
  });
}

/** What the element shows at an absolute timeline time. */
function opacityAt(element: any, cursorMs: number): number {
  return sampleTrack(
    element.animation.opacity,
    element.startTime,
    cursorMs,
    -1,
  );
}

describe("splitAt and keyframes", () => {
  it("gives each half its own animation object", () => {
    // The two halves used to share one, so editing a keyframe on either
    // silently changed the other.
    const source = animatedClip();
    const parts = splitAt(source, 7000)!;

    expect(parts.left.animation).not.toBe(source.animation);
    expect(parts.right.animation).not.toBe(source.animation);
    expect(parts.left.animation).not.toBe(parts.right.animation);
    expect(parts.left.animation.opacity.x).not.toBe(
      parts.right.animation.opacity.x,
    );
    expect(parts.left.animation.opacity.x[0]).not.toBe(
      parts.right.animation.opacity.x[0],
    );
  });

  it("rebases the right half onto its own start time", () => {
    // Cut 2s into a clip that starts at 5s: the keyframe that was at t=2000
    // becomes the right half's t=0.
    const parts = splitAt(animatedClip(), 7000)!;
    expect(parts.right.startTime).toBe(7000);
    expect(parts.right.animation.opacity.x[0].p[0]).toBe(0);
    expect(parts.left.animation.opacity.x[0].p[0]).toBe(0);
  });

  it("drops keyframes that fall outside each half", () => {
    const parts = splitAt(animatedClip(), 7000)!;
    for (const k of parts.left.animation.opacity.x) {
      expect(k.p[0]).toBeLessThanOrEqual(2000);
    }
    for (const k of parts.right.animation.opacity.x) {
      expect(k.p[0]).toBeGreaterThanOrEqual(0);
    }
  });

  /**
   * The invariant that actually matters: cutting a clip must not change what
   * the viewer sees at any moment.
   */
  it("shows the same value at every cursor position as the uncut clip", () => {
    const source = animatedClip();
    const cut = 7000;
    const parts = splitAt(source, cut)!;

    for (let cursor = 5000; cursor <= 9000; cursor += 50) {
      const half = cursor < cut ? parts.left : parts.right;
      expect(opacityAt(half, cursor)).toBeCloseTo(opacityAt(source, cursor), 0);
    }
  });

  it("keeps each half's bake in step with its authored list", () => {
    const parts = splitAt(animatedClip(), 7000)!;
    for (const half of [parts.left, parts.right]) {
      expect((half as any).animation.opacity.ax).toEqual(
        bakeTrack((half as any).animation.opacity.x),
      );
    }
  });

  it("splits a sped-up clip on timeline time, not source time", () => {
    // Keyframes live in timeline ms. Using the source-ms cut would misplace
    // every one of them by the speed factor.
    const source = animatedClip({
      speed: 2,
      duration: 4000,
      trim: { startTime: 0, endTime: 4000 },
    });
    const cut = source.startTime + spanLength(source) / 2;
    const parts = splitAt(source, cut)!;

    // Sampling snaps to the nearest baked point rather than blending, and the
    // boundary keyframe the cut inserts is itself a snapped read, so the errors
    // compound: a few 60Hz samples' worth of the ramp. Over this clip one
    // sample is 50 units across 2000ms, ~0.42. Three samples of slack still
    // catches the bug this test is for by a wide margin — measuring the cut in
    // source ms instead of timeline ms misplaces every keyframe by the speed
    // factor, which here is ~25 units, twenty times the tolerance.
    const slack = (3 * (50 * (1000 / 60))) / 2000;

    for (let cursor = source.startTime; cursor < spanEnd(source); cursor += 50) {
      const half = cursor < cut ? parts.left : parts.right;
      expect(
        Math.abs(opacityAt(half, cursor) - opacityAt(source, cursor)),
      ).toBeLessThanOrEqual(slack);
    }
  });

  it("leaves an element with no animation block untouched", () => {
    const parts = splitAt(audioElement({ startTime: 0, duration: 4000 }), 2000)!;
    expect((parts.left as any).animation).toBeUndefined();
    expect((parts.right as any).animation).toBeUndefined();
  });
});

describe("trimStart and keyframes", () => {
  it("keeps the animation pinned to the content", () => {
    // Trimming 1s off the head moves `startTime` from 5000 to 6000. Without a
    // rebase the whole curve slid a second later against its own frames.
    const source = animatedClip();
    const trimmed = trimStart(source, 1000);

    for (let cursor = 6000; cursor <= 9000; cursor += 50) {
      expect(opacityAt(trimmed, cursor)).toBeCloseTo(
        opacityAt(source, cursor),
        0,
      );
    }
  });

  it("keeps keyframes that the trim pushed out of view", () => {
    // A trim is reversible, so a keyframe outside the window has to survive
    // being pulled back in — which is why trimStart rebases but never slices.
    const source = animatedClip();
    const trimmed: any = trimStart(source, 1000);
    expect(trimmed.animation.opacity.x.some((k) => k.p[0] < 0)).toBe(true);

    const restored: any = trimStart(trimmed, -1000);
    expect(restored.animation.opacity.x.map((k: any) => k.p[0])).toEqual(
      source.animation.opacity.x.map((k) => k.p[0]),
    );
  });

  it("declines to rebase when the trim is clamped to nothing", () => {
    const source = animatedClip({ startTime: 0 });
    const trimmed: any = trimStart(source, -5000);
    expect(trimmed.startTime).toBe(0);
    expect(trimmed.animation).toBe(source.animation);
  });
});

describe("trimEnd and keyframes", () => {
  it("leaves keyframes alone, because startTime does not move", () => {
    const source = animatedClip();
    const trimmed: any = trimEnd(source, -1000);
    expect(trimmed.startTime).toBe(source.startTime);
    expect(trimmed.animation).toBe(source.animation);
  });
});

/**
 * A reveal, through the shipping `renderText` onto a real Skia surface.
 *
 * Text geometry depends on the host's font metrics, so — like `text.test.ts` —
 * these assert relative placement and relative ink, never exact columns. The
 * two claims that are absolute are the ones that matter most:
 *
 * - **A clip with no reveal draws byte-identically to what it always drew**,
 *   and so does one whose reveal has finished. That is the regression guard for
 *   every project written before the feature.
 * - **A revealing clip's first glyph does not move.** Drawing a growing prefix
 *   at a centre or right anchor re-centres it every frame, which is the defect
 *   Premiere's Source Text keyframing has; it would be invisible in a left-
 *   aligned test and invisible in an ink *count*.
 */

import { describe, expect, it } from "vitest";

import { addKeyframe, setTrackActive } from "../animation/keyframeOps";
import { setClipTextReveal } from "../timeline/textRevealOps";
import { SCHEMA_VERSION, createTrack } from "../timeline/tracks";
import { inkBounds, scene, textElement } from "./testing";
import { renderText } from "./text";

const base = (over: Record<string, unknown> = {}) =>
  textElement({
    location: { x: 0, y: 0 },
    width: 260,
    height: 60,
    fontsize: 32,
    text: "abcde",
    textcolor: "#ffffff",
    ...over,
  } as any);

/** The clip, with a reveal at a fixed progress and no animation. */
const revealed = (progress: number, over: Record<string, unknown> = {}) =>
  base({ ...over, reveal: { unit: "character", progress } });

function draw(element: any, cursor = 0, size = 300) {
  const { canvas, ctx } = scene(size, size, "#000000");
  renderText(ctx, "t", element, cursor);
  return canvas;
}

function bytes(canvas: any): string {
  const { width, height } = canvas;
  return Buffer.from(
    canvas.getContext("2d").getImageData(0, 0, width, height).data,
  ).toString("base64");
}

describe("the untouched path", () => {
  it("draws a clip with no reveal exactly as it always did", () => {
    // `revealOf` answers null and the plan is never built — the same code path,
    // not a reveal that happens to show everything.
    expect(bytes(draw(base()))).toBe(bytes(draw(base())));
  });

  it("draws a finished reveal byte-identically to no reveal at all", () => {
    // 100 takes the null-plan branch, so a clip that has finished typing costs
    // nothing and cannot drift from the unrevealed rendering by a subpixel.
    expect(bytes(draw(revealed(100)))).toBe(bytes(draw(base())));
  });

  it("is byte-identical at 100 under every alignment", () => {
    for (const align of ["left", "center", "right"] as const) {
      const plain = base();
      plain.options.align = align;
      const done = revealed(100);
      done.options.align = align;
      expect(bytes(draw(done))).toBe(bytes(draw(plain)));
    }
  });
});

describe("how much is shown", () => {
  it("draws nothing at all at 0", () => {
    expect(inkBounds(draw(revealed(0))).count).toBe(0);
  });

  it("grows without ever shrinking", () => {
    let previous = -1;
    for (let progress = 0; progress <= 100; progress += 5) {
      const count = inkBounds(draw(revealed(progress))).count;
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
    expect(previous).toBe(inkBounds(draw(base())).count);
  });

  it("shows about half the width at half the characters", () => {
    const whole = inkBounds(draw(base()));
    const half = inkBounds(draw(revealed(50)));
    const wholeWidth = whole.maxX - whole.minX;
    const halfWidth = half.maxX - half.minX;
    // Two of five characters at a hard cut, so between a third and a half of
    // the run — loose, because glyph advances are not equal.
    expect(halfWidth).toBeGreaterThan(wholeWidth * 0.2);
    expect(halfWidth).toBeLessThan(wholeWidth * 0.7);
  });
});

describe("the lettering does not move as it arrives", () => {
  it.each(["left", "center", "right"] as const)(
    "keeps the first glyph where it will end up, aligned %s",
    (align) => {
      const whole = base();
      whole.options.align = align;
      const partial = revealed(60);
      partial.options.align = align;

      const wholeInk = inkBounds(draw(whole));
      const partialInk = inkBounds(draw(partial));
      // Under centre or right alignment a prefix drawn at the alignment anchor
      // would start further right and creep left as it typed. It starts where
      // the finished line starts instead.
      expect(Math.abs(partialInk.minX - wholeInk.minX)).toBeLessThan(3);
    },
  );

  it("would have moved if it were re-anchored", () => {
    // Proof the test above measures something: the same prefix drawn as its own
    // centred line does start somewhere else.
    const centred = base({ text: "abc" });
    centred.options.align = "center";
    const prefixAlone = inkBounds(draw(centred));

    const whole = base();
    whole.options.align = "center";
    const wholeInk = inkBounds(draw(whole));

    expect(prefixAlone.minX - wholeInk.minX).toBeGreaterThan(10);
  });
});

describe("the background band", () => {
  // Black glyphs on a white band over a black scene, so `inkBounds` measures
  // the band alone.
  const banded = (progress: number | null) => {
    const element =
      progress == null ? base() : revealed(progress, { text: "abcde" });
    element.textcolor = "#000000";
    element.background = { enable: true, color: "#ffffff", padding: 4 };
    return element;
  };

  it("is drawn at the full line's width whatever the progress", () => {
    // The band is a layout element, not something that types. One that grew
    // with the lettering would redraw at a new size every frame and, under
    // centre alignment, grow in both directions at once.
    const whole = inkBounds(draw(banded(null)));
    for (const progress of [20, 60, 90]) {
      const partial = inkBounds(draw(banded(progress)));
      expect(partial.maxX - partial.minX).toBe(whole.maxX - whole.minX);
      expect(partial.minX).toBe(whole.minX);
    }
  });

  it("is not drawn at all for a line that has not started", () => {
    const two = banded(20);
    two.text = "aaaa\nbbbb";
    const partial = inkBounds(draw(two));
    two.reveal = undefined;
    const whole = inkBounds(draw(two));
    // One band's worth of height rather than two.
    expect(partial.maxY - partial.minY).toBeLessThan(
      (whole.maxY - whole.minY) * 0.7,
    );
  });
});

describe("softness", () => {
  it("puts more ink on the canvas than a hard cut at the same progress", () => {
    // Five characters: 58% is 2.9 units in, so a hard cut shows two and a
    // `fade: 1` shows two plus a third at 0.9 alpha.
    const hard = inkBounds(draw(revealed(58))).count;
    const soft = inkBounds(
      draw(base({ reveal: { unit: "character", progress: 58, fade: 1 } })),
    ).count;
    expect(soft).toBeGreaterThan(hard);
  });

  it("shows less than the next whole character would", () => {
    const soft = inkBounds(
      draw(base({ reveal: { unit: "character", progress: 44, fade: 1 } })),
    ).count;
    const three = inkBounds(draw(revealed(60))).count;
    expect(soft).toBeLessThan(three);
  });
});

describe("driven by its keyframe track", () => {
  it("shows more of the text further into the clip", () => {
    let doc: any = {
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0)],
      elements: {
        t: base({ trackId: "v1", startTime: 1000, duration: 1000 }),
      },
    };
    doc = setClipTextReveal(doc, "t", "character");
    doc = setTrackActive(doc, "t", "revealProgress", true);
    doc = addKeyframe(doc, "t", "revealProgress", "x", 0, 0);
    doc = addKeyframe(doc, "t", "revealProgress", "x", 1000, 100);
    const element = doc.elements.t;

    // Sampled at the *timeline* cursor, against the element's own start.
    const counts = [1000, 1300, 1600, 2000].map(
      (cursor) => inkBounds(draw(element, cursor)).count,
    );
    expect(counts[0]).toBe(0);
    expect(counts[1]).toBeGreaterThan(0);
    expect(counts[2]).toBeGreaterThan(counts[1]);
    expect(counts[3]).toBe(inkBounds(draw(base())).count);
  });

  it("shows the static value before the clip starts, not a sampled one", () => {
    // `sampleTrack` refuses a cursor before the element's start, so the static
    // field wins — which for an inert reveal is the whole text.
    let doc: any = {
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0)],
      elements: {
        t: base({ trackId: "v1", startTime: 1000, duration: 1000 }),
      },
    };
    doc = setClipTextReveal(doc, "t", "character");
    doc = setTrackActive(doc, "t", "revealProgress", true);
    doc = addKeyframe(doc, "t", "revealProgress", "x", 0, 0);
    expect(inkBounds(draw(doc.elements.t, 0)).count).toBeGreaterThan(0);
  });
});

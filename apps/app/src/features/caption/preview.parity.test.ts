import { describe, expect, it } from "vitest";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import type { Timeline } from "../../@types/timeline";
import { createTextElement } from "../element/textElement";
import { renderText } from "../renderer/text";
import { renderTimelineAtTime } from "../renderer/timeline";
import { inkBounds } from "../renderer/testing";
import { linesFromWordGroups, setLineText, type CaptionLine } from "./lines";
import { paintCaptionPreview } from "./preview";
import { captionRows } from "./rows";

/**
 * **The panel draws the element it will place.**
 *
 * CLAUDE.md states this as "0 differing pixels of 2,073,600", measured once by
 * hand. This is that claim as a test, and it is structural: one side is
 * `paintCaptionPreview`, the other is `captionRows` → `createTextElement` →
 * `renderTimelineAtTime`, which is the export path the delivered file comes out
 * of. Neither side restates the other's arithmetic.
 *
 * ## Why comparing two renders is host-independent
 *
 * `golden.test.ts` deliberately keeps text out of its digests, because font
 * metrics come from whichever face the host resolves and a digest would differ
 * between machines. That does not apply here: this asserts the **difference**
 * between two renders in one process, with one font resolution, which is the
 * same reason `tests/e2e/specs/background-export.spec.ts` asserts a difference
 * rather than an absolute.
 *
 * ## The trap this suite has to avoid
 *
 * `paint` filters on `isElementVisibleAtTime`, and the preview does not — it
 * calls `renderElement` directly. So an element whose span does not contain the
 * cursor is drawn by the preview and skipped by the compositor, and the
 * comparison becomes "a painted frame against a blank one", which differs in
 * zero pixels only because *both* are the background. **Every case asserts ink
 * before asserting equality.** A first draft of this file passed with the cursor
 * outside the span.
 *
 * ## The one way parity can still be broken in future
 *
 * A frosted background band (`background.blur > 0`). `renderElement` captures
 * `ctx.canvas` as the backdrop and `renderText` blurs it, so the two paths would
 * read different backdrops — the preview's carries the clip's picture, the
 * compositor's carries the real clip. `resolveTextStyle` defaults the blur to 0,
 * so `frostBackdrop` is never entered today and no caption sets it.
 */

const FRAME = { w: 1920, h: 1080 };
const BG = "#101014";

/**
 * Inside the caption's own span, and inside `createTextElement`'s default
 * 1000ms, so the compositor's visibility filter admits the element.
 */
const CURSOR_MS = 500;

/** One caption, 0..900ms, with no edge whitespace — see the trailing-space case. */
function line(text = "the quick brown fox jumps over the lazy dog"): CaptionLine[] {
  const built = linesFromWordGroups([
    [
      { word: "the", start: 0, end: 0.3 },
      { word: "quick", start: 0.3, end: 0.6 },
      { word: "brown", start: 0.6, end: 0.9 },
    ],
  ]);
  return [{ ...built[0], text }];
}

function surface() {
  const canvas = createCanvas(FRAME.w, FRAME.h);
  return {
    canvas,
    ctx: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
  };
}

function bytes(canvas: Canvas): Uint8ClampedArray {
  return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
}

/** Side A: what the panel shows. */
function preview(lines: CaptionLine[], placement: "lowerThird" | "center") {
  const { canvas, ctx } = surface();
  paintCaptionPreview(ctx, {
    canvasSize: FRAME,
    frame: FRAME,
    backgroundColor: BG,
    lines,
    progressSec: CURSOR_MS / 1000,
    placement,
    sourceImage: null,
  });
  return canvas;
}

/**
 * Side B: what lands on the timeline.
 *
 * The emit path verbatim — `captionRows` builds the row, `Control` strips
 * `sourceKey` and `addText` hands the rest to `createTextElement`. The only
 * thing `placeNewElement` adds on top is `startTime` and `trackId`, and
 * `startTime` is what `captionToTimeline` decides, which is a separate contract
 * with its own suite (`timing.test.ts`).
 */
function placed(lines: CaptionLine[], placement: "lowerThird" | "center") {
  const rows = captionRows(lines, "clip-1", FRAME, placement);
  expect(rows, "the fixture must produce a row to compare").toHaveLength(1);
  const { sourceKey, ...options } = rows[0];

  const timeline: Timeline = { caption: createTextElement(options) };
  const { canvas, ctx } = surface();
  renderTimelineAtTime(
    ctx,
    timeline,
    CURSOR_MS,
    { text: renderText } as unknown as Parameters<typeof renderTimelineAtTime>[3],
    BG,
    FRAME.w,
    FRAME.h,
  );
  return canvas;
}

/** How many RGBA pixels differ at all. */
function differingPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  expect(a.length).toBe(b.length);
  let differing = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      a[i] !== b[i] ||
      a[i + 1] !== b[i + 1] ||
      a[i + 2] !== b[i + 2] ||
      a[i + 3] !== b[i + 3]
    ) {
      differing += 1;
    }
  }
  return differing;
}

describe("the preview and the placed caption are the same picture", () => {
  for (const placement of ["lowerThird", "center"] as const) {
    it(`agrees in every pixel (${placement})`, () => {
      const a = preview(line(), placement);
      const b = placed(line(), placement);

      // Guard first: two blank frames also differ in zero pixels, which is how a
      // visibility-filtered element would make this vacuously green.
      expect(inkBounds(a).count).toBeGreaterThan(5_000);
      expect(inkBounds(b).count).toBeGreaterThan(5_000);

      expect(differingPixels(bytes(a), bytes(b))).toBe(0);
    });
  }

  it("compares a full 1080p frame, the figure CLAUDE.md quotes", () => {
    expect(bytes(preview(line(), "lowerThird")).length / 4).toBe(2_073_600);
  });

  it("puts the caption in the same place, not merely the same pixels somewhere", () => {
    // Independent of the byte comparison: if both sides were blank this would
    // fail, and if one were offset the bounds would differ.
    const a = inkBounds(preview(line(), "lowerThird"));
    const b = inkBounds(placed(line(), "lowerThird"));

    expect(a).toEqual(b);
    expect(a.minY).toBeGreaterThan(FRAME.h / 2);
  });

  it("still agrees for a single short word", () => {
    const short = line("hi");
    expect(inkBounds(preview(short, "center")).count).toBeGreaterThan(100);
    expect(differingPixels(bytes(preview(short, "center")), bytes(placed(short, "center"))))
      .toBe(0);
  });

  it("still agrees for text long enough to wrap", () => {
    // `width` is the wrapping width, so a long line exercises `layoutFor`'s
    // wrap cache on both sides — the same cache, keyed on the same resolved font.
    const long = line(
      "a caption long enough that it has to wrap onto a second line and " +
        "probably a third one as well, which is what makes the wrap width matter",
    );
    const a = preview(long, "lowerThird");
    const b = placed(long, "lowerThird");

    expect(inkBounds(a).count).toBeGreaterThan(5_000);
    expect(differingPixels(bytes(a), bytes(b))).toBe(0);
  });

  it("still agrees for a caption the user has retyped", () => {
    // An edited line keeps its own timing and gets a new string, which is the
    // normal state of every caption by the time Complate is pressed.
    const edited = setLineText(line(), 0, "corrected wording here");
    const a = preview(edited, "center");
    const b = placed(edited, "center");

    expect(inkBounds(a).count).toBeGreaterThan(1_000);
    expect(differingPixels(bytes(a), bytes(b))).toBe(0);
  });

  it("still agrees for CJK text, which wraps by a different rule", () => {
    const korean = line("자동 캡션이 화면에 보이는 그대로 놓입니다");
    const a = preview(korean, "lowerThird");
    const b = placed(korean, "lowerThird");

    expect(inkBounds(a).count).toBeGreaterThan(1_000);
    expect(differingPixels(bytes(a), bytes(b))).toBe(0);
  });
});

describe("where the two sides do NOT agree", () => {
  it("diverges for a line with a trailing space, because only one side trims", () => {
    // Findings F14, pinned rather than fixed. `captionRows` emits
    // `line.text.trim()` and the preview draws `line.text`, so under
    // `optionsAlign: "center"` a trailing space changes `measureText` and with it
    // both the centred draw position and the background band's width.
    //
    // This is a real counterexample to "parity is structural", reachable by
    // typing a space at the end of a caption. It is recorded here so the claim
    // above is read with its exception, and so a future fix has a test to flip.
    const padded = setLineText(line(), 0, "hello there ");
    const a = preview(padded, "center");
    const b = placed(padded, "center");

    expect(inkBounds(a).count).toBeGreaterThan(100);
    expect(inkBounds(b).count).toBeGreaterThan(100);
    expect(differingPixels(bytes(a), bytes(b))).toBeGreaterThan(0);
  });

  it("agrees again once the same text is trimmed", () => {
    // Proof the divergence above is the whitespace and nothing else.
    const trimmed = setLineText(line(), 0, "hello there");
    expect(differingPixels(bytes(preview(trimmed, "center")), bytes(placed(trimmed, "center"))))
      .toBe(0);
  });
});

describe("the guard this suite depends on", () => {
  it("would be vacuously green without the ink assertion", () => {
    // Demonstrates the trap rather than trusting the comment. With the cursor
    // outside the caption's span, the preview draws nothing and the compositor
    // draws nothing, so the frames are identical — and meaningless.
    const { canvas: emptyPreview, ctx } = surface();
    paintCaptionPreview(ctx, {
      canvasSize: FRAME,
      frame: FRAME,
      backgroundColor: BG,
      lines: line(),
      progressSec: 99,
      placement: "lowerThird",
      sourceImage: null,
    });

    const rows = captionRows(line(), "clip-1", FRAME, "lowerThird");
    const { sourceKey, ...options } = rows[0];
    const { canvas: emptyPlaced, ctx: ctx2 } = surface();
    renderTimelineAtTime(
      ctx2,
      { caption: createTextElement(options) },
      99_000,
      { text: renderText } as unknown as Parameters<typeof renderTimelineAtTime>[3],
      BG,
      FRAME.w,
      FRAME.h,
    );

    expect(differingPixels(bytes(emptyPreview), bytes(emptyPlaced))).toBe(0);
    // …and this is why that proves nothing.
    expect(inkBounds(emptyPreview).count).toBe(0);
    expect(inkBounds(emptyPlaced).count).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { inkBounds, pixel, solid } from "../renderer/testing";
import { captionStyle } from "./layout";
import { linesFromWordGroups, type CaptionLine } from "./lines";
import { captionElementAt, paintCaptionPreview } from "./preview";

/**
 * The preview's pixels, on a real Skia canvas.
 *
 * Font metrics come from whichever face the host resolves, so nothing here
 * asserts an absolute position — only relations that hold in any face: where the
 * ink sits relative to the frame, that the band is opaque, that nothing is drawn
 * outside a caption's span. `preview.parity.test.ts` is where exact pixels are
 * compared, and it does so between two renders in one process, which is what
 * makes that comparison host-independent.
 */

const FRAME = { w: 480, h: 270 };
const BG = "#101014";

function surface(w = FRAME.w, h = FRAME.h) {
  const canvas = createCanvas(w, h);
  return {
    canvas,
    ctx: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
  };
}

/** One caption covering 0..3s. */
const lines = (text = "hello there world"): CaptionLine[] => {
  const built = linesFromWordGroups([
    [
      { word: "hello", start: 0, end: 1 },
      { word: "there", start: 1, end: 2 },
      { word: "world", start: 2, end: 3 },
    ],
  ]);
  return [{ ...built[0], text }];
};

const paint = (over: Partial<Parameters<typeof paintCaptionPreview>[1]> = {}) => {
  const { canvas, ctx } = surface(
    over.canvasSize?.w ?? FRAME.w,
    over.canvasSize?.h ?? FRAME.h,
  );
  paintCaptionPreview(ctx, {
    canvasSize: FRAME,
    frame: FRAME,
    backgroundColor: BG,
    lines: lines(),
    progressSec: 1.5,
    placement: "lowerThird",
    sourceImage: null,
    ...over,
  });
  return canvas;
};

describe("paintCaptionPreview: the background", () => {
  it("fills with the project's background colour", () => {
    const canvas = paint();
    // A corner, well away from any caption.
    expect(pixel(canvas, 2, 2)).toEqual({ r: 0x10, g: 0x10, b: 0x14, a: 255 });
  });

  it("fills rather than clears, so repeated paints do not stack", () => {
    // There was no clear of any kind here before, so an audio-only clip stacked
    // every caption it had ever drawn on top of the last. Painting twice must
    // give the same picture as painting once.
    const once = paint();
    const { canvas: twice, ctx } = surface();
    const state = {
      canvasSize: FRAME,
      frame: FRAME,
      backgroundColor: BG,
      lines: lines(),
      progressSec: 1.5,
      placement: "lowerThird" as const,
      sourceImage: null,
    };
    paintCaptionPreview(ctx, state);
    paintCaptionPreview(ctx, state);

    expect(bytes(twice)).toEqual(bytes(once));
  });

  it("covers the whole backing store when it is larger than the frame", () => {
    // The fill is sized by the canvas, the layout by the frame. A canvas bigger
    // than the frame must still be fully painted, with no uninitialised corner.
    const canvas = paint({
      canvasSize: { w: 640, h: 360 },
      frame: FRAME,
    });

    expect(pixel(canvas, 639, 359)).toEqual({ r: 0x10, g: 0x10, b: 0x14, a: 255 });
    expect(pixel(canvas, 0, 0)).toEqual({ r: 0x10, g: 0x10, b: 0x14, a: 255 });
  });

  it("leaves an opaque frame, whatever was drawn", () => {
    const data = bytes(paint());
    for (let i = 3; i < data.length; i += 4) {
      expect(data[i]).toBe(255);
    }
  });
});

describe("paintCaptionPreview: when a caption is drawn", () => {
  it("draws nothing but the background before the first line", () => {
    const empty = paint({ progressSec: -1 });
    expect(inkBounds(empty).count).toBe(0);
  });

  it("draws nothing but the background after the last line", () => {
    expect(inkBounds(paint({ progressSec: 99 })).count).toBe(0);
  });

  it("draws nothing for a transcript with no lines", () => {
    expect(inkBounds(paint({ lines: [] })).count).toBe(0);
  });

  it("draws the caption inside its own span", () => {
    expect(inkBounds(paint({ progressSec: 1.5 })).count).toBeGreaterThan(100);
  });

  it("treats the span as half open, matching the timeline", () => {
    // `[start, end)`, so the first instant draws and the last does not — the
    // convention that makes the panel and the placed captions agree at a
    // boundary.
    expect(inkBounds(paint({ progressSec: 0 })).count).toBeGreaterThan(100);
    expect(inkBounds(paint({ progressSec: 3 })).count).toBe(0);
  });
});

describe("paintCaptionPreview: placement", () => {
  it("puts a lower-third caption below a centred one", () => {
    const low = inkBounds(paint({ placement: "lowerThird" }));
    const mid = inkBounds(paint({ placement: "center" }));

    expect(low.minY).toBeGreaterThan(mid.minY);
  });

  it("keeps a lower-third caption in the bottom half of the frame", () => {
    expect(inkBounds(paint({ placement: "lowerThird" })).minY).toBeGreaterThan(
      FRAME.h / 2,
    );
  });

  it("keeps every caption inside the frame", () => {
    for (const placement of ["lowerThird", "center"] as const) {
      const ink = inkBounds(paint({ placement }));
      expect(ink.minX).toBeGreaterThanOrEqual(0);
      expect(ink.minY).toBeGreaterThanOrEqual(0);
      expect(ink.maxX).toBeLessThan(FRAME.w);
      expect(ink.maxY).toBeLessThan(FRAME.h);
    }
  });

  it("lays the caption out in the frame, not the canvas", () => {
    // A canvas larger than the frame must not move the caption: the box comes
    // from `captionStyle(frame)`. This is the half that would break if the two
    // sizes were collapsed into one.
    const sameFrame = inkBounds(paint({ canvasSize: { w: 640, h: 360 }, frame: FRAME }));
    const baseline = inkBounds(paint());

    expect(sameFrame.minY).toBe(baseline.minY);
    expect(sameFrame.minX).toBe(baseline.minX);
  });
});

describe("paintCaptionPreview: the source frame", () => {
  const red = () => solid(FRAME.w, FRAME.h, "#ff0000") as unknown as CanvasImageSource;

  it("draws the clip's picture under the caption", () => {
    const canvas = paint({ sourceImage: red(), progressSec: 1.5 });
    expect(pixel(canvas, 2, 2)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });

  it("omits it entirely when there is none, leaving the background", () => {
    expect(pixel(paint({ sourceImage: null }), 2, 2)).toEqual({
      r: 0x10,
      g: 0x10,
      b: 0x14,
      a: 255,
    });
  });

  it("draws it at the frame's size, not the canvas's", () => {
    // A 4K clip in a 1080p project overflows here exactly as it will on the
    // timeline, instead of being silently squashed to fit. With a canvas larger
    // than the frame, the picture must stop at the frame's edge and leave
    // background beyond it.
    const canvas = paint({
      canvasSize: { w: 640, h: 360 },
      frame: FRAME,
      sourceImage: red(),
    });

    expect(pixel(canvas, FRAME.w - 2, FRAME.h - 2)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, FRAME.w + 10, FRAME.h + 10)).toEqual({
      r: 0x10,
      g: 0x10,
      b: 0x14,
      a: 255,
    });
  });

  it("does not move the caption", () => {
    // The picture goes underneath. Its presence must not shift the text, or the
    // preview would disagree with the export for any clip that had loaded a
    // frame.
    //
    // The stand-in is #202020 rather than the red above: `inkBounds` counts any
    // channel over 40, so a bright full-frame picture is *entirely* ink and the
    // bounds it reports are the canvas, which would make this assertion pass
    // whatever the text did. At 32 per channel the picture is invisible to
    // `inkBounds` and still distinguishable from the #101014 background.
    const dim = () =>
      solid(FRAME.w, FRAME.h, "#202020") as unknown as CanvasImageSource;

    const over = inkBounds(paint({ sourceImage: dim() }));
    const alone = inkBounds(paint({ sourceImage: null }));

    // Both really did see a caption, and the picture really was drawn.
    expect(alone.count).toBeGreaterThan(100);
    expect(pixel(paint({ sourceImage: dim() }), 2, 2)).toEqual({
      r: 32,
      g: 32,
      b: 32,
      a: 255,
    });

    expect(over.minY).toBe(alone.minY);
    expect(over.maxY).toBe(alone.maxY);
    expect(over.minX).toBe(alone.minX);
    expect(over.maxX).toBe(alone.maxX);
  });
});

describe("captionElementAt", () => {
  it("is the style plus that line's text", () => {
    const element = captionElementAt(lines(), 0, FRAME, "lowerThird");
    const style = captionStyle(FRAME, "lowerThird");

    expect(element.text).toBe("hello there world");
    expect(element.fontsize).toBe(style.fontsize);
    expect(element.width).toBe(style.width);
    expect(element.location).toEqual({ x: style.locationX, y: style.locationY });
    expect(element.options.align).toBe("center");
    expect(element.background.enable).toBe(true);
  });

  it("draws the text as typed, untrimmed", () => {
    // `captionRows` trims and this does not, so a trailing space diverges. The
    // divergence is measured in `preview.parity.test.ts`; here it is only
    // recorded that this side keeps the raw string.
    expect(captionElementAt(lines("hi  "), 0, FRAME, "center").text).toBe("hi  ");
  });

  it("answers an empty string for a line that is not there", () => {
    expect(captionElementAt(lines(), 9, FRAME, "center").text).toBe("");
  });
});

/** Raw RGBA, for whole-frame comparisons. */
function bytes(canvas: Canvas): Uint8ClampedArray {
  return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
}

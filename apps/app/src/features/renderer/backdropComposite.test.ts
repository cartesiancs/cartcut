import { describe, it, expect, afterEach } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { renderElement } from "./element";
import { renderText } from "./text";
import { resetLayers, setSurfaceFactory, type Surface } from "./surface";
import { scene, textElement } from "./testing";
import { defaultMask } from "../mask/maskShape";
import type { MaskType, TextElementType } from "../../@types/timeline";

/**
 * A frosted text band through `renderElement`, which is the only place the
 * backdrop comes from.
 *
 * `text.test.ts` drives `renderText` with a backdrop handed to it directly, so
 * it proves the blur works. What it cannot prove is that a backdrop *arrives* —
 * and that is the whole of this feature's plumbing, because the clip may be
 * drawn onto the frame or onto an isolation layer and only one of those has the
 * picture on it:
 *
 *  - **fast path** — no blend, no mask, no grade: `ctx` is the frame, and the
 *    backdrop is that same canvas, used as its own source.
 *  - **isolated path** — a blend mode, a mask, a LUT or a colour adjustment:
 *    `ctx` is a transparent layer. Reading `ctx.canvas` here would frost
 *    nothing at all, silently, and every test that drew the clip on its own
 *    would still pass. That is the case this file exists for.
 *  - **a transition** — `isolated: true`: each half is drawn into a cleared
 *    buffer, so there genuinely is no backdrop and the frost must decline
 *    rather than sample a hole.
 *
 * The backdrop is a sharp red/blue step. Frosted means the step became a ramp.
 */

const skiaFactory = (width: number, height: number): Surface => {
  const canvas = createCanvas(width, height);
  return {
    canvas: canvas as unknown as Surface["canvas"],
    ctx: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
  };
};

afterEach(() => {
  setSurfaceFactory(skiaFactory);
  resetLayers();
});

const SIZE = 400;
/** The element sits here, and the backdrop's step runs down its x = 0. */
const PLACED = 100;

/** A text clip whose band is a wide, untinted sheet of glass. */
function frostedText(over: Partial<TextElementType> = {}): TextElementType {
  const element = textElement({
    location: { x: PLACED, y: PLACED },
    width: 240,
    height: 60,
    fontsize: 40,
    // A space: not a blank line — which draws no band — but no glyphs either.
    text: " ",
    textcolor: "#ffffff",
    ...over,
  });
  element.background = {
    enable: true,
    color: "#000000",
    // Transparent, so what is measured is the frost and not a wash of colour.
    opacity: 0,
    padding: 60,
    radius: 0,
    blur: 12,
  };
  return element;
}

/**
 * Two lines whose bands overlap, with a tint dark enough to see.
 *
 * A band is `ascent + descent + 2 * padding` tall against an advance of
 * `1.2 * fontsize`, so at any generous padding the bands of consecutive lines
 * cover each other — which is what makes this the interesting shape for the
 * frost rather than a contrived one.
 */
function overlappingLines(over: Partial<TextElementType> = {}): TextElementType {
  // Two spaces rather than two words, and that is not squeamishness: Skia
  // renders glyphs differently onto a surface with alpha than onto an opaque one
  // — measured, up to 189 of 255 on an antialiased edge — so a *lettered* clip
  // cannot be compared byte-for-byte across the two paths at all. Nothing about
  // the band depends on there being glyphs in it.
  const element = frostedText({ text: " \n ", ...over });
  element.background.opacity = 50;
  return element;
}

/** A mask over the left half of the element's box, hard-edged. */
function leftHalf(): MaskType {
  return {
    ...defaultMask("rectangle"),
    location: { x: 25, y: 50 },
    size: { width: 50, height: 100 },
  };
}

/**
 * A mask far larger than the element's box, centred on it.
 *
 * Here to force the isolated path while leaving the picture alone, which is what
 * makes a byte-for-byte comparison against the fast path mean anything. Mask
 * geometry is a percentage of the *box*, and a band reaches `padding` outside it
 * on every side — a 300% mask on this 240x60 box stops at element y = 120 and
 * quietly trims the second line's band, which is a test that fails for a reason
 * that has nothing to do with what it is testing. 2000% puts every edge well off
 * the canvas.
 */
function coversEverything(): MaskType {
  return {
    ...defaultMask("rectangle"),
    location: { x: 50, y: 50 },
    size: { width: 2000, height: 2000 },
  };
}

function draw(
  element: TextElementType,
  options: { isolated?: boolean } = {},
): ReturnType<typeof scene>["canvas"] {
  const { canvas, ctx } = scene(SIZE, SIZE);
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, PLACED, SIZE);
  ctx.fillStyle = "#0000ff";
  ctx.fillRect(PLACED, 0, SIZE - PLACED, SIZE);

  renderElement(ctx, "el", element, 0, false, renderText, {
    elements: { el: element },
    isolated: options.isolated,
  });
  return canvas;
}

/** How many pixels on `y` hold a mix of the two solids rather than either one. */
function rampWidth(
  canvas: ReturnType<typeof scene>["canvas"],
  y: number,
): number {
  const d = canvas.getContext("2d").getImageData(0, y, SIZE, 1).data;
  let mixed = 0;
  for (let x = 0; x < SIZE; x += 1) {
    const r = d[x * 4];
    const b = d[x * 4 + 2];
    if (r > 20 && r < 235 && b > 20 && b < 235) {
      mixed += 1;
    }
  }
  return mixed;
}

/** A row through the middle of the band. */
const BAND_ROW = PLACED + 40;

describe("a frosted band through renderElement", () => {
  it("frosts the frame on the fast path", () => {
    // No blend, no mask, no grade: the clip is drawn straight onto the frame, so
    // the backdrop is the destination canvas acting as its own drawImage source.
    expect(rampWidth(draw(frostedText()), BAND_ROW)).toBeGreaterThan(20);
  });

  it("frosts through the isolated path, to the same picture", () => {
    // The case the parameter exists for. A mask sends the clip to a transparent
    // layer; a renderer reading `ctx.canvas` would find nothing there, and the
    // band would silently stop being glass the moment anyone masked, blended,
    // graded or adjusted the clip.
    //
    // The mask covers everything the clip draws, so it cuts nothing and the two
    // paths have to agree **to the byte** — the strongest form of the claim,
    // since the layer shares the frame's pixel grid and the frost therefore
    // lands in the same place whichever surface it is drawn onto.
    //
    // Two tinted lines, deliberately: at this padding their bands overlap, and
    // that is the case that separates frosting the union of the bands from
    // frosting them one at a time. Done one at a time, the second band on the
    // *fast* path would blur the first band's tint into its own glass — the
    // frame having been mutated in between — while on the isolated path it would
    // read a pristine frame. Both are defensible; differing is not.
    const fast = draw(overlappingLines());
    const layered = draw(overlappingLines({ mask: coversEverything() }));

    // A narrower window than the untinted case above: half the tint's range is
    // gone, so fewer pixels register as a mix of the two solids.
    expect(rampWidth(layered, BAND_ROW)).toBeGreaterThan(8);
    expect(
      Buffer.from(layered.getContext("2d").getImageData(0, 0, SIZE, SIZE).data),
    ).toEqual(
      Buffer.from(fast.getContext("2d").getImageData(0, 0, SIZE, SIZE).data),
    );
  });

  it("frosts under a blend mode", () => {
    // The other way onto the layer, and the common one. Asserted as a
    // difference rather than as a ramp, because `multiply` against a saturated
    // backdrop flattens one channel of the frost and any threshold on the mix
    // would be measuring the blend instead: what matters is that frosting
    // changed the picture at all, which is precisely what reading the wrong
    // surface would not have done.
    const frosty = draw(frostedText({ blend: "multiply" }));

    const flat = frostedText({ blend: "multiply" });
    flat.background.blur = 0;
    const plain = draw(flat);

    let differing = 0;
    const a = frosty.getContext("2d").getImageData(0, BAND_ROW, SIZE, 1).data;
    const b = plain.getContext("2d").getImageData(0, BAND_ROW, SIZE, 1).data;
    for (let x = 0; x < SIZE; x += 1) {
      if (Math.abs(a[x * 4] - b[x * 4]) > 8 || Math.abs(a[x * 4 + 2] - b[x * 4 + 2]) > 8) {
        differing += 1;
      }
    }
    expect(differing).toBeGreaterThan(20);
  });

  it("is cut by a mask, like the rest of the clip", () => {
    // The frost is part of the clip's picture rather than something painted
    // under it, so a mask cuts it exactly as it cuts the band and the lettering.
    const masked = draw(frostedText({ mask: leftHalf() }));
    const whole = draw(frostedText());

    // The mask keeps element x in [0, 120) — frame [100, 220) — which is the
    // right-hand half of the ramp and none of its left.
    const cut = rampWidth(masked, BAND_ROW);
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(rampWidth(whole, BAND_ROW));

    // Beyond the mask the frame is untouched, though the band's own right end
    // reaches x = 271: pure blue, with no ramp and no tint.
    const d = masked.getContext("2d").getImageData(0, BAND_ROW, SIZE, 1).data;
    for (let x = 240; x < SIZE; x += 1) {
      expect([d[x * 4], d[x * 4 + 1], d[x * 4 + 2]]).toEqual([0, 0, 255]);
    }
  });

  it("draws no frost inside a transition", () => {
    // `fx/compositor.ts#renderClip` draws each half into a cleared, transparent
    // buffer. There is nothing beneath the clip to blur, so the frost declines —
    // the same reasoning that suspends a blend mode there, and it must not
    // instead sample the empty buffer and punch a hole in the dissolve.
    expect(rampWidth(draw(frostedText(), { isolated: true }), BAND_ROW)).toBe(0);
  });

  it("still draws the band's colour inside a transition", () => {
    // Only the frost is suspended. The band itself is an ordinary fill, so a
    // caption does not change shape for the length of a transition.
    const tinted = frostedText();
    tinted.background.opacity = 100;
    tinted.background.color = "#00ff00";

    const canvas = draw(tinted, { isolated: true });
    const d = canvas.getContext("2d").getImageData(0, BAND_ROW, SIZE, 1).data;
    // The band spans the element's x = -60..71, i.e. 40..171 on the frame.
    expect([d[100 * 4], d[100 * 4 + 1], d[100 * 4 + 2]]).toEqual([0, 255, 0]);
  });

  it("leaves an unfrosted clip on the untouched path", () => {
    // `blur` absent or 0 must reach the frame as the same pixels a band always
    // drew — no backdrop read, no blur, no layer.
    const plain = frostedText();
    plain.background.blur = 0;
    plain.background.opacity = 100;

    const zero = draw(plain);
    const absent = frostedText();
    absent.background.opacity = 100;
    delete absent.background.blur;

    const a = zero.getContext("2d").getImageData(0, 0, SIZE, SIZE).data;
    const b = draw(absent).getContext("2d").getImageData(0, 0, SIZE, SIZE).data;
    expect(Buffer.from(a)).toEqual(Buffer.from(b));
    expect(rampWidth(zero, BAND_ROW)).toBe(0);
  });
});

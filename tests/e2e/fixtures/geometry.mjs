/**
 * Where the instrument bands sit inside a frame, and how big the instruments
 * that fill them are.
 *
 * Shared by the fixture generator (which renders the instruments) and by the
 * specs (which read pixels back out of those bands), because the two must agree
 * to the pixel. A band described twice is a band that will eventually be
 * described differently in the two places, and the symptom would be a
 * frame-parity failure that looks like a renderer bug.
 *
 * Plain `.mjs` with no imports so `fetch.mjs` can load it directly under node
 * and the TypeScript side can load it through the same path without a build
 * step in between.
 *
 * Layout, top to bottom:
 *
 *     +--------------------------------------------------+
 *     | code    (frame index, one patch per bit)          |
 *     | swatch  (8 colour patches, colorimetry canary)    |
 *     |                                                  |
 *     |            content  <- everything the editor      |
 *     |                        actually composites, and   |
 *     |                        the only region any        |
 *     |                        fidelity metric reads      |
 *     |                                                  |
 *     | ticker  (scrolling pattern, alignment carrier)    |
 *     +--------------------------------------------------+
 */

/** Frames an export of this profile produces — `features/export/frames.ts`. */
export function frameCount(profile) {
  return Math.round(profile.durationSec * profile.fps);
}

/** Even, because most encoders reject odd dimensions. */
function even(n) {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r + 1;
}

/**
 * The instrument bands for a profile, in project pixels.
 *
 * Sizes are derived from the frame rather than fixed, so `smoke` gets bands it
 * can actually fit (a 96 px code patch would need 1440 px of a 640 px frame)
 * and `extreme` gets bands that are still readable after the frame quadruples.
 */
export function regionsFor(profile) {
  const { width, height } = profile;

  // One patch per bit of the largest frame index. 18000 frames needs 15 bits.
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, frameCount(profile)))));
  // A twentieth of the frame keeps the patch far larger than any plausible
  // resampling kernel, so sampling the centre can never see a neighbour.
  const codePatch = even(Math.max(8, width / 20));

  const code = { x: 0, y: 0, w: bits * codePatch, h: codePatch, bits, patch: codePatch };

  const swatchCount = 8;
  const swatchW = even((width * 2) / 3 / swatchCount);
  const swatchH = even(codePatch * 1.25);
  const swatch = {
    x: 0,
    y: code.h,
    w: swatchW * swatchCount,
    h: swatchH,
    count: swatchCount,
    patchW: swatchW,
  };

  const tickerH = even(height * 0.118);
  const ticker = { x: 0, y: height - tickerH, w: width, h: tickerH };

  const content = {
    x: 0,
    y: swatch.y + swatch.h,
    w: width,
    h: ticker.y - (swatch.y + swatch.h),
  };

  return { code, swatch, ticker, content };
}

/**
 * The eight canary colours, in authored (full-range sRGB) values.
 *
 * Primaries and secondaries at full saturation are where a wrong YUV matrix
 * shows up hardest — a bt709 decode of a bt601 encode moves pure green by 42
 * codes while leaving grey untouched — and the two neutrals pin the range
 * conversion, which moves white by 19 and leaves the primaries comparatively
 * alone. Between them the two failure modes are separable.
 */
export const SWATCH_COLORS = [
  { name: "red", rgb: [255, 0, 0] },
  { name: "green", rgb: [0, 255, 0] },
  { name: "blue", rgb: [0, 0, 255] },
  { name: "cyan", rgb: [0, 255, 255] },
  { name: "magenta", rgb: [255, 0, 255] },
  { name: "yellow", rgb: [255, 255, 0] },
  { name: "grey50", rgb: [128, 128, 128] },
  { name: "white", rgb: [255, 255, 255] },
];

/** How far the ticker pattern travels per frame, in project pixels. */
export const TICKER_SHIFT_PX = 32;

/** Edge length of one block of the ticker's pattern. */
export const TICKER_BLOCK_PX = 4;

/**
 * Period, in frames, of the animation alignment carrier (the "A2" carrier).
 *
 * A shape whose x position sawtooths over this many frames. Read back as
 * `frame mod ANIM_CARRIER_PERIOD`, it says which frame the *animation* system
 * thinks it is on — with no video decoder involved anywhere. Comparing it
 * against the code strip, which does involve one, is what separates "the video
 * seek is off by one" from "the frame clock is off by one".
 */
export const ANIM_CARRIER_PERIOD = 120;

/** Pixels the animation carrier travels per frame. */
export const ANIM_CARRIER_STEP_PX = 8;

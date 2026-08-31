/**
 * The picture every LUT tile shows.
 *
 * **Fixed.** It does not depend on the project, the playhead, the selection or
 * anything else that can change, and that is the whole point: a grid of eighty
 * tiles is only useful as a *comparison*, and a comparison needs the thing being
 * compared to hold still. A thumbnail sourced from the timeline changes under
 * the user every time the playhead moves — two LUTs looked at ten seconds
 * apart would have been judged against different pictures, which is worse than
 * useless because it is not obviously wrong.
 *
 * Drawn in code rather than shipped as a photograph, for three reasons:
 *
 *  - it cannot go missing, fail to decode, or arrive late;
 *  - it is byte-identical on every machine, so a screenshot of the panel is
 *    comparable across builds and `lut-panel.spec.ts` can assert on it;
 *  - a photograph shows one scene's opinion of a grade, while a chart shows
 *    what the grade *does* — which is the question someone scanning eighty
 *    tiles is actually asking.
 *
 * ## What it contains, and why each part earns its space
 *
 * Every band answers something a colourist looks for first:
 *
 * | band | what it reveals |
 * |---|---|
 * | sky gradient, with a warm corner | white balance, and how highlights roll off |
 * | four skin tones, light to deep | the thing a bad grade ruins first |
 * | foliage and earth | how greens are handled — the other common casualty |
 * | saturated primaries and secondaries | saturation, and any hue rotation |
 * | a full black-to-white ramp | lifted blacks, crushed shadows, clipped whites |
 *
 * The ramp runs to **true 0 and true 255** deliberately: a matte LUT's lifted
 * black and a high-contrast LUT's clipping are both invisible on a chart that
 * never reaches the ends.
 */

/** Tile size. 16:9, and small enough that grading eighty costs milliseconds. */
export const SAMPLE_WIDTH = 192;
export const SAMPLE_HEIGHT = 108;

/**
 * Draw the sample onto a 2D context, at whatever size it is.
 *
 * Deterministic: no randomness, no clock, no measurement of anything outside
 * `width` and `height`. `sampleImage.test.ts` pins that two calls produce
 * identical pixels, which is what "never changes" means in practice.
 */
export function drawSampleImage(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";

  const skyH = Math.round(height * 0.32);
  const toneH = Math.round(height * 0.3);
  const chipH = Math.round(height * 0.19);
  const rampH = height - skyH - toneH - chipH;

  // Sky: cool at the top, pale at the horizon, with a warm corner standing in
  // for low sun. The warm/cool split across one continuous surface is what
  // makes a white-balance shift obvious at thumbnail size.
  const sky = ctx.createLinearGradient(0, 0, 0, skyH);
  sky.addColorStop(0, "#1d5c9e");
  sky.addColorStop(0.55, "#7fb4dd");
  sky.addColorStop(1, "#d8e6ef");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, skyH);

  const sun = ctx.createRadialGradient(
    width * 0.82,
    skyH * 0.72,
    0,
    width * 0.82,
    skyH * 0.72,
    skyH * 1.25,
  );
  sun.addColorStop(0, "rgba(255, 232, 180, 0.95)");
  sun.addColorStop(1, "rgba(255, 232, 180, 0)");
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, width, skyH);

  // Skin, foliage and earth. Four skin tones because a grade that flatters one
  // complexion and turns another is the single most common failure, and a chart
  // with one skin swatch cannot show it.
  const tones = [
    "#f4d9c0", // fair
    "#dda87f", // light-mid
    "#a9714b", // mid-deep
    "#5d3a26", // deep
    "#3f6b3a", // foliage, shadow side
    "#86a95c", // foliage, lit
  ];
  paintRow(ctx, tones, 0, skyH, width, toneH);

  // The primaries and secondaries, at a saturation a camera can actually
  // record rather than at the corners of the cube — a grade's effect on
  // fully-clipped colour says nothing about what it does to a picture.
  const chips = [
    "#cc2a24",
    "#2f9e44",
    "#2a52be",
    "#22a6b3",
    "#b5299a",
    "#d9a520",
  ];
  paintRow(ctx, chips, 0, skyH + toneH, width, chipH);

  // True black to true white. Both ends matter: this is where a lifted black
  // or a clipped highlight becomes visible at 192 pixels wide.
  const ramp = ctx.createLinearGradient(0, 0, width, 0);
  ramp.addColorStop(0, "#000000");
  ramp.addColorStop(1, "#ffffff");
  ctx.fillStyle = ramp;
  ctx.fillRect(0, skyH + toneH + chipH, width, rampH);

  ctx.restore();
}

/** Equal-width swatches across a band, with no gaps from rounding. */
function paintRow(
  ctx: CanvasRenderingContext2D,
  colors: string[],
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  for (let i = 0; i < colors.length; i++) {
    const from = Math.round((width * i) / colors.length);
    const to = Math.round((width * (i + 1)) / colors.length);
    ctx.fillStyle = colors[i];
    ctx.fillRect(x + from, y, to - from, height);
  }
}

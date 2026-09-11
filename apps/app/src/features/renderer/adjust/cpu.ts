/**
 * The finishing adjustments with `ImageData`, on the CPU.
 *
 * The same two jobs `lut/cpu.ts` has: the fallback that ships where WebGL
 * cannot be had, and the path the node suites drive. Built from
 * `adjust/finishMath.ts` and nothing else, and it samples exactly the way the
 * shader does — linear filtering, clamped at the edge, taps at the same
 * offsets — so it is also the oracle `tests/e2e/specs/adjust.spec.ts` compares
 * the GPU against.
 *
 * ## The blurs average premultiplied colour
 *
 * The layer holds one clip against transparency, and both blurs — sharpen's
 * tent and clarity's Gaussian — reach past the clip's edge. Averaging
 * *straight* colour there reads the transparent pixels' black as picture and
 * sharpens a rim onto the border. So every tap samples premultiplied colour,
 * `rgb·a` and `a` interpolated together, and the average divides by the summed
 * alpha. That is the only form in which a half-covered sample counts half, and
 * it is what the GPU applier gets by uploading the layer a second time with
 * `UNPACK_PREMULTIPLY_ALPHA_WEBGL`.
 *
 * ## The whole layer, not the clip's box
 *
 * Content can spill well past the box — a text clip's glow, a wide shadow —
 * and a finish that stopped at the box would draw a seam through it. Only
 * pixels with coverage are finished, so the empty part of the layer costs a
 * scan rather than a finish, and a transparent pixel is left exactly as it was.
 */

import {
  BLUR_TAPS,
  TENT_3X3,
  finishPixel,
  hash12,
  luma,
  type FinishInputs,
} from "../../adjust/finishMath";
import type { Rgb } from "../../lut/colorMath";
import type { Surface } from "../surface";
import type { FinishApplier, FinishRender } from "./apply";

/** Four floats per pixel. */
type Plane = { data: Float32Array; width: number; height: number };

/**
 * Linear filtering, clamped to the edge: what `texture2D` with `LINEAR` and
 * `CLAMP_TO_EDGE` returns for a sample at device position `(x, y)`, where
 * pixel `i` has its centre at `i + 0.5`.
 */
export function sampleLinear(
  plane: Plane,
  x: number,
  y: number,
  out: Float32Array,
): void {
  const { data, width, height } = plane;
  const fx = Math.min(Math.max(x - 0.5, 0), width - 1);
  const fy = Math.min(Math.max(y - 0.5, 0), height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = (y0 * width + x0) * 4;
  const b = (y0 * width + x1) * 4;
  const c = (y1 * width + x0) * 4;
  const d = (y1 * width + x1) * 4;
  for (let k = 0; k < 4; k++) {
    const top = data[a + k] + (data[b + k] - data[a + k]) * tx;
    const bottom = data[c + k] + (data[d + k] - data[c + k]) * tx;
    out[k] = top + (bottom - top) * ty;
  }
}

/**
 * One separable pass of clarity's blur, as each of the shader's two blur
 * passes does it.
 *
 * `fromColor` true reads premultiplied RGBA and emits `(L·a, a)` — luma is
 * linear, so the luma of premultiplied colour *is* `L·a`. False reads the
 * previous pass's `(L·a, a)` and blurs it along the other axis.
 */
function blurPass(
  source: Plane,
  dx: number,
  dy: number,
  step: number,
  fromColor: boolean,
): Plane {
  const { width, height } = source;
  const out: Plane = { data: new Float32Array(width * height * 4), width, height };
  const s = new Float32Array(4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let la = 0;
      let a = 0;
      for (const tap of BLUR_TAPS) {
        sampleLinear(
          source,
          x + 0.5 + dx * tap.offset * step,
          y + 0.5 + dy * tap.offset * step,
          s,
        );
        if (fromColor) {
          la += tap.weight * luma([s[0], s[1], s[2]]);
          a += tap.weight * s[3];
        } else {
          la += tap.weight * s[0];
          a += tap.weight * s[1];
        }
      }
      const i = (y * width + x) * 4;
      out.data[i] = la;
      out.data[i + 1] = a;
    }
  }
  return out;
}

export function createCpuFinishApplier(): FinishApplier {
  return {
    apply(surface: Surface, render: FinishRender): boolean {
      const width = surface.canvas.width;
      const height = surface.canvas.height;
      if (!(width > 0) || !(height > 0)) {
        return false;
      }

      let image: ImageData;
      try {
        image = surface.ctx.getImageData(0, 0, width, height);
      } catch {
        // A tainted canvas cannot be read back, and throwing out of the paint
        // loop mid-export is not an option.
        return false;
      }
      const bytes = image.data;
      const { amounts } = render;
      const needsNeighbours = amounts.clarity > 0 || amounts.sharpen > 0;

      // Premultiplied, for the taps. The centre pixel is read straight from
      // `bytes`, exactly as the shader reads it from the straight texture.
      const premultiplied: Plane | null = needsNeighbours
        ? { data: new Float32Array(width * height * 4), width, height }
        : null;
      if (premultiplied != null) {
        for (let i = 0; i < bytes.length; i += 4) {
          const a = bytes[i + 3] / 255;
          premultiplied.data[i] = (bytes[i] / 255) * a;
          premultiplied.data[i + 1] = (bytes[i + 1] / 255) * a;
          premultiplied.data[i + 2] = (bytes[i + 2] / 255) * a;
          premultiplied.data[i + 3] = a;
        }
      }

      const blurred =
        amounts.clarity > 0 && premultiplied != null
          ? blurPass(
              blurPass(premultiplied, 1, 0, render.clarityStep, true),
              0,
              1,
              render.clarityStep,
              false,
            )
          : null;

      const s = new Float32Array(4);
      const inputs: FinishInputs = {
        blurredLuma: 0,
        blurredRgb: [0, 0, 0],
        u: 0,
        v: 0,
        noise: 0,
      };
      const inv = render.toLocal;
      const [offX, offY] = render.grainOffset;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (bytes[i + 3] === 0) {
            continue;
          }
          const src: Rgb = [bytes[i] / 255, bytes[i + 1] / 255, bytes[i + 2] / 255];

          if (blurred != null) {
            const la = blurred.data[i];
            const a = blurred.data[i + 1];
            inputs.blurredLuma = a > 1e-6 ? la / a : luma(src);
          }

          if (amounts.sharpen > 0 && premultiplied != null) {
            let r = 0;
            let g = 0;
            let b = 0;
            let total = 0;
            for (const tap of TENT_3X3) {
              sampleLinear(
                premultiplied,
                x + 0.5 + tap.dx * render.sharpenStep,
                y + 0.5 + tap.dy * render.sharpenStep,
                s,
              );
              r += s[0] * tap.weight;
              g += s[1] * tap.weight;
              b += s[2] * tap.weight;
              total += s[3] * tap.weight;
            }
            inputs.blurredRgb =
              total > 1e-6 ? [r / total, g / total, b / total] : src;
          }

          // The pixel centre, in the clip's own pixels.
          const cx = x + 0.5;
          const cy = y + 0.5;
          const lx = inv.a * cx + inv.c * cy + inv.e;
          const ly = inv.b * cx + inv.d * cy + inv.f;
          inputs.u = lx / render.box.width;
          inputs.v = ly / render.box.height;

          if (amounts.particles > 0) {
            inputs.noise = hash12(
              Math.floor(lx / render.grainCell) + offX,
              Math.floor(ly / render.grainCell) + offY,
            );
          }

          const out = finishPixel(src, inputs, amounts);
          bytes[i] = toByte(out[0] * 255);
          bytes[i + 1] = toByte(out[1] * 255);
          bytes[i + 2] = toByte(out[2] * 255);
        }
      }

      // Under identity, explicitly. The spec says `putImageData` ignores the
      // transform, and Chromium does — but `@napi-rs/canvas` applies it, and
      // the layer arrives still carrying the destination's zoom. Without this
      // every node suite that draws at a scale other than 1 writes the finished
      // layer back magnified, and the app, which is right, would disagree with
      // the tests, which would be wrong.
      surface.ctx.save();
      surface.ctx.setTransform(1, 0, 0, 1, 0, 0);
      surface.ctx.putImageData(image, 0, 0);
      surface.ctx.restore();
      return true;
    },

    dispose(): void {
      // Nothing is held.
    },
  };
}

/** Round to nearest and clamp — the GPU's own rounding, as `lut/cpu.ts` argues. */
function toByte(value: number): number {
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

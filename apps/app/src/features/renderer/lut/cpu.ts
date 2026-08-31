/**
 * Grading with `ImageData`, on the CPU.
 *
 * Two jobs, and it is the same code doing both:
 *
 *  - **The fallback that ships.** A machine with no usable WebGL context still
 *    grades; it grades slowly, and it grades correctly.
 *  - **The path the node suites run.** `renderer/lutComposite.test.ts` drives
 *    the real `renderElement` with this applier and a Skia surface, and checks
 *    the resulting bytes against `sampleLut`. Because this is a shipping path
 *    and not a test double, that suite is testing the app rather than a mock.
 *
 * ## Alpha
 *
 * `getImageData` is defined to return **straight**, non-premultiplied values,
 * so the grade goes straight onto `data[i]` with no unpremultiply step — the
 * same numbers the GPU shader sees, for the reasons set out in `lut/glsl.ts`.
 * Alpha itself is left alone: a LUT is a colour transform and says nothing
 * about coverage.
 *
 * ## Speed
 *
 * A 1920×1080 layer is two million tetrahedral lookups, which is tens of
 * milliseconds — fine for an export and too slow for a 60fps preview. That is
 * the whole reason the GPU applier is tried first. The one concession made
 * here is a **memo keyed on the packed 8-bit colour**: real footage has far
 * fewer distinct colours than pixels, a solid title card has one, and the map
 * turns the second occurrence of a colour into a lookup. It is exact, not an
 * approximation — the key is the entire input.
 */

import { sampleLut } from "../../lut/sample";
import type { LutData } from "../../lut/lutData";
import type { Surface } from "../surface";
import type { LutApplier } from "./apply";

/**
 * Stop memoising past this many distinct colours.
 *
 * A photographic frame can hold a million, at which point the map costs more
 * than it saves and grows without bound. Past the cap the remaining pixels are
 * graded directly; the entries already collected keep paying off.
 */
const MAX_MEMO = 1 << 16;

export function createCpuLutApplier(): LutApplier {
  return {
    apply(surface: Surface, _key: string, lut: LutData, amount: number): boolean {
      const width = surface.canvas.width;
      const height = surface.canvas.height;
      if (!(width > 0) || !(height > 0)) {
        return false;
      }

      let image: ImageData;
      try {
        image = surface.ctx.getImageData(0, 0, width, height);
      } catch {
        // A tainted canvas cannot be read back. Nothing here can fix that, and
        // throwing out of the paint loop mid-export is not an option.
        return false;
      }

      const data = image.data;
      const memo = new Map<number, number>();
      const out = { r: 0, g: 0, b: 0 };
      const keep = 1 - amount;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        const key = (r << 16) | (g << 8) | b;
        const cached = memo.get(key);
        if (cached !== undefined) {
          data[i] = (cached >> 16) & 0xff;
          data[i + 1] = (cached >> 8) & 0xff;
          data[i + 2] = cached & 0xff;
          continue;
        }

        sampleLut(lut, r / 255, g / 255, b / 255, "tetrahedral", out);
        const nr = toByte(r * keep + out.r * 255 * amount);
        const ng = toByte(g * keep + out.g * 255 * amount);
        const nb = toByte(b * keep + out.b * 255 * amount);

        data[i] = nr;
        data[i + 1] = ng;
        data[i + 2] = nb;
        if (memo.size < MAX_MEMO) {
          memo.set(key, (nr << 16) | (ng << 8) | nb);
        }
      }

      surface.ctx.putImageData(image, 0, 0);
      return true;
    },

    dispose(): void {
      // Nothing is held.
    },
  };
}

/**
 * Round to a byte and clamp.
 *
 * `Math.round` rather than a truncation: the GPU rounds to nearest when it
 * writes an 8-bit render target, and a half-LSB bias here would put the two
 * appliers systematically one step apart on flat areas — a difference the
 * end-to-end preview/export comparison would report as a real failure.
 */
function toByte(value: number): number {
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

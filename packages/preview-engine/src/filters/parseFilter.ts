/**
 * Filter parameter parsing.
 *
 * The chromakey/blur value strings ("r=0:g=255:b=0:f=0.5", "f=8") were parsed by
 * `parseRGBString` / `parseBlurString` that were duplicated across glFilter.ts,
 * controllers/render.ts and offscreen-render.ts (with subtly different int vs
 * float behaviour). This is the single canonical parser; the WebGL filter code
 * consumes it once. Bugs in filters live here, so this is heavily unit-tested.
 */

export type ChromaKeyParams = { r: number; g: number; b: number; f: number };
export type BlurParams = { f: number };

/** Parse "r=..:g=..:b=..:f=.." into normalized channel values. `f` (threshold /
 * force) defaults to 1 and is parsed as a float; r/g/b are 0..255 floats. */
export function parseRGBString(str: string): ChromaKeyParams {
  const parts = str.split(":");
  let r = 0;
  let g = 0;
  let b = 0;
  let f = 1;

  for (const item of parts) {
    const [key, value] = item.split("=");
    const numValue = parseFloat(value);
    switch (key) {
      case "r":
        r = numValue;
        break;
      case "g":
        g = numValue;
        break;
      case "b":
        b = numValue;
        break;
      case "f":
        f = numValue;
        break;
      default:
        break;
    }
  }

  return { r, g, b, f };
}

/** Parse "f=.." into a blur factor (integer, matching the original). */
export function parseBlurString(str: string): BlurParams {
  const parts = str.split(":");
  let f = 0;

  for (const item of parts) {
    const [key, value] = item.split("=");
    const numValue = parseInt(value, 10);
    if (key === "f") f = numValue;
  }

  return { f };
}

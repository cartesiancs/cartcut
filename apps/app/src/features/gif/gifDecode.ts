/**
 * A GIF file, decoded into what `renderer/gif.ts` draws from.
 *
 * Each frame's patch becomes a canvas of the patch's own size, drawn later at
 * its offset with `drawImage`. Not `putImageData` onto the picture: that
 * replaces pixels, so a patch's transparent pixels would erase the frames
 * underneath them instead of letting them show through.
 *
 * The canvases come from `renderer/surface.ts#makeSurface`, so the node
 * suites decode and draw through the same code the app runs.
 */

import { decompressFrames, parseGIF } from "gifuct-js";

import { makeSurface, type Surface } from "../renderer/surface";
import type { GifFrameInfo } from "./gifCompose";
import { gifTiming, type GifTiming } from "./gifTiming";

export type LoadedGif = {
  /** The GIF's logical screen, which every frame's rectangle sits inside. */
  width: number;
  height: number;
  frames: readonly GifFrameInfo[];
  /** Frame `i`'s patch, or `null` for an empty rectangle or no canvas. */
  patches: readonly (Surface["canvas"] | null)[];
  timing: GifTiming;
};

export function decodeGif(buffer: ArrayBuffer): LoadedGif {
  const parsed = parseGIF(buffer);
  const decoded = decompressFrames(parsed, true).filter((frame) => frame != null);

  const frames: GifFrameInfo[] = [];
  const patches: (Surface["canvas"] | null)[] = [];
  let right = 0;
  let bottom = 0;

  for (const frame of decoded) {
    const { left, top, width, height } = frame.dims;
    frames.push({
      rect: { left, top, width, height },
      disposal: frame.disposalType ?? 0,
    });
    right = Math.max(right, left + width);
    bottom = Math.max(bottom, top + height);

    const surface = makeSurface(width, height);
    if (surface == null || frame.patch.length !== width * height * 4) {
      patches.push(null);
      continue;
    }
    const image = surface.ctx.createImageData(width, height);
    image.data.set(frame.patch);
    surface.ctx.putImageData(image, 0, 0);
    patches.push(surface.canvas);
  }

  // A malformed header can say 0x0. The frames still say how big the
  // picture is.
  const width = parsed.lsd.width > 0 ? parsed.lsd.width : right;
  const height = parsed.lsd.height > 0 ? parsed.lsd.height : bottom;

  return {
    width,
    height,
    frames,
    patches,
    timing: gifTiming(decoded.map((frame) => frame.delay)),
  };
}

import type { RenderElement } from "../../model/timeline.types";
import type { CanvasCtx, RenderDeps } from "../types";

/**
 * Draw a GIF element. The resolver owns frame decoding and the scratch canvas
 * (see `pickGifFrameIndex` for the shared indexing rule); the drawer composites
 * the frame it returns, centered with rotation.
 *
 * GIFs carry no keyframe animation in any of the original renderers, so only the
 * element's static `opacity` applies. Setting it is what the export copies
 * forgot — without it a GIF inherited whatever `globalAlpha` the previously
 * drawn element happened to leave behind.
 */
export function drawGif(
  ctx: CanvasCtx,
  id: string,
  el: RenderElement,
  timeMs: number,
  deps: RenderDeps,
): boolean {
  const source = deps.assets.getGifFrame(id, el, timeMs);
  if (!source) return false;

  const x = el.location?.x ?? 0;
  const y = el.location?.y ?? 0;
  const w = Number(el.width) || 0;
  const h = Number(el.height) || 0;
  const rotation = (Number(el.rotation) || 0) * (Math.PI / 180);

  ctx.globalAlpha = (Number(el.opacity) || 0) / 100;

  const centerX = x + w / 2;
  const centerY = y + h / 2;

  ctx.translate(centerX, centerY);
  ctx.rotate(rotation);
  ctx.drawImage(source, -w / 2, -h / 2, w, h);
  ctx.rotate(-rotation);
  ctx.translate(-centerX, -centerY);
  ctx.globalAlpha = 1;
  return true;
}

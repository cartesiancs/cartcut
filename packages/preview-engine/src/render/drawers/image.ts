import type { RenderElement } from "../../model/timeline.types";
import type { CanvasCtx, RenderDeps } from "../types";
import { resolveBoxTransform } from "../transform";

/** Draw an image element. Faithful port of the (thrice-duplicated) drawImage:
 * animated box transform, centered translate/rotate, alpha. */
export function drawImage(
  ctx: CanvasCtx,
  id: string,
  el: RenderElement,
  timeMs: number,
  deps: RenderDeps,
): boolean {
  const source = deps.assets.getImage(id, el);
  if (!source) return false;

  const tf = resolveBoxTransform(el, timeMs, {
    ignorePosition: deps.ignorePositionIds?.has(id),
  });
  if (tf.abort) return false;

  ctx.globalAlpha = tf.alpha;
  const centerX = tf.scaleX + tf.scaleW / 2;
  const centerY = tf.scaleY + tf.scaleH / 2;

  ctx.translate(centerX, centerY);
  ctx.rotate(tf.rotation);
  ctx.drawImage(source, -tf.scaleW / 2, -tf.scaleH / 2, tf.scaleW, tf.scaleH);
  ctx.rotate(-tf.rotation);
  ctx.translate(-centerX, -centerY);
  ctx.globalAlpha = 1;
  return true;
}

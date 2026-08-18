import type { RenderElement } from "../../model/timeline.types";
import type { CanvasCtx, RenderDeps, ImageSource } from "../types";
import { resolveBoxTransform } from "../transform";
import { glFilter } from "../../filters/glFilter";

/**
 * Draw a video element. The resolver supplies the already-seeked frame source;
 * this applies the WebGL filters then composites with the animated box
 * transform. The seek/`seeked`-event async lives in the caller (export awaits it
 * before compositing, preview is best-effort), which keeps this synchronous.
 *
 * Two behaviours here follow the preview rather than the export copies:
 *   - every filter in `filter.list` is applied in order, not just `list[0]`
 *   - `isChangeFilter` is honoured so the shader re-initialises after an edit
 * and the position keyframe track is actually applied (the export copies
 * computed the animated coordinates and then dropped them on the floor).
 *
 * Filters receive the *un-animated* box, matching the originals — the animated
 * transform is applied afterwards when compositing the filtered output.
 */
export function drawVideo(
  ctx: CanvasCtx,
  id: string,
  el: RenderElement,
  timeMs: number,
  deps: RenderDeps,
): boolean {
  const video = deps.assets.getVideo(id, el);
  if (!video) return false;

  let source: ImageSource = video.object;

  const filter = el.filter;
  if (filter?.enable && filter.list && filter.list.length > 0) {
    const w = Number(el.width) || 0;
    const h = Number(el.height) || 0;
    const x = el.location?.x ?? 0;
    const y = el.location?.y ?? 0;

    for (const entry of filter.list) {
      const apply =
        entry.name === "chromakey"
          ? glFilter.applyChromaKey
          : entry.name === "blur"
            ? glFilter.applyBlur
            : entry.name === "radialblur"
              ? glFilter.applyRadialBlur
              : undefined;
      if (!apply) continue;

      const filtered = apply(
        ctx,
        video,
        el,
        w,
        h,
        x,
        y,
        w,
        h,
        deps.isChangeFilter,
      );
      // A failed shader init returns undefined; keep the last good source.
      if (filtered) source = filtered;
    }
  }

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

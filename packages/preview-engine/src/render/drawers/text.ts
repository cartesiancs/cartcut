import type { RenderElement } from "../../model/timeline.types";
import type { CanvasCtx, RenderDeps } from "../types";
import {
  sampleScale,
  sampleRotation,
  samplePosition,
  sampleOpacityAlpha,
} from "../../animation/sample";
import { wrapTextLines } from "../../text/wrap";
import { alignedLineX, textBackgroundBox } from "../../text/layout";

function fontString(el: RenderElement, fontSize: number): string {
  const italic = el.options?.isItalic ? "italic" : "";
  const bold = el.options?.isBold ? "bold" : "";
  return `${italic} ${bold} ${fontSize}px ${el.fontname}`;
}

function drawTextStroke(
  ctx: CanvasCtx,
  el: RenderElement,
  text: string,
  x: number,
  y: number,
  fontSize: number,
): void {
  if (!el.options?.outline?.enable) return;
  ctx.font = fontString(el, fontSize);
  ctx.lineWidth = parseInt(String(el.options.outline.size), 10);
  ctx.strokeStyle = el.options.outline.color as string;
  ctx.strokeText(text, x, y);
}

/**
 * Draw a text element: opacity / scale (which scales the font, not the box) /
 * rotation / position keyframes, centered rotation, then a background pass and a
 * text pass over the same wrapped lines.
 *
 * Both passes wrap identically — same greedy rule, same max width, same font —
 * so the lines are computed once and shared. The originals ran the loop twice
 * and, in each, spelled out the same three-way align branch; that placement is
 * now `alignedLineX` / `textBackgroundBox`.
 *
 * Three quirks are deliberately preserved, all of them identical across the
 * original renderers (so none is a preview-vs-export divergence):
 *   - the scale track is divided by 10 twice, so text reads it as `raw / 100`
 *     while image and video read the same track as `raw / 10`. A track value of
 *     100 leaves text at its authored size; 10 shrinks it to a tenth.
 *   - the first baseline offset uses the element's *un-animated* `fontsize`
 *     even when the scale track is driving the rendered font size
 *   - the line advance is the element's `height`, not a font-derived line height
 */
export function drawText(
  ctx: CanvasCtx,
  id: string,
  el: RenderElement,
  timeMs: number,
  deps: RenderDeps,
): boolean {
  const w = Number(el.width) || 0;
  const h = Number(el.height) || 0;
  let tx = el.location?.x ?? 0;
  let ty = el.location?.y ?? 0;
  let fontSize = Number(el.fontsize) || 0;
  let rotation = (Number(el.rotation) || 0) * (Math.PI / 180);

  try {
    ctx.globalAlpha = (Number(el.opacity) || 0) / 100;

    const opacity = sampleOpacityAlpha(el, timeMs);
    if (opacity === false) return false;
    if (typeof opacity === "number") ctx.globalAlpha = opacity;

    const scale = sampleScale(el, timeMs);
    if (typeof scale === "number") {
      // sampleScale already returned raw/10; dividing again is what every
      // original renderer did. See the note above before "fixing" this.
      fontSize = (Number(el.fontsize) || 0) * (scale / 10);
    }

    const rot = sampleRotation(el, timeMs);
    if (rot && typeof rot === "object") rotation = rot.ax;

    ctx.fillStyle = el.textcolor as string;
    ctx.lineWidth = 0;
    (ctx as unknown as { letterSpacing: string }).letterSpacing =
      `${el.letterSpacing}px`;
    ctx.font = fontString(el, fontSize);

    const position = samplePosition(el, timeMs);
    if (position === false) return false;
    if (
      position &&
      typeof position === "object" &&
      !deps.ignorePositionIds?.has(id)
    ) {
      tx = position.ax ?? 0;
      ty = position.ay ?? 0;
    }

    const centerX = tx + w / 2;
    const centerY = ty + h / 2;

    ctx.translate(centerX, centerY);
    ctx.rotate(rotation);

    tx = -w / 2;
    ty = -h / 2;

    const align = el.options?.align ?? "left";
    const measure = (s: string) => ctx.measureText(s).width;
    const lines = wrapTextLines(measure, el.text ?? "", w);

    if (el.background?.enable) {
      ctx.fillStyle = el.background.color as string;
      let bgY = ty;
      for (const line of lines) {
        const box = textBackgroundBox(align, tx, w, measure(line));
        ctx.fillRect(box.x, bgY, box.width, h);
        bgY += h;
      }
    }

    ctx.fillStyle = el.textcolor as string;

    let textY = ty + (Number(el.fontsize) || 0);
    for (const line of lines) {
      const drawX = alignedLineX(align, tx, w, measure(line));
      drawTextStroke(ctx, el, line, drawX, textY, fontSize);
      ctx.fillText(line, drawX, textY);
      textY += h;
    }

    ctx.rotate(-rotation);
    ctx.translate(-centerX, -centerY);
    ctx.globalAlpha = 1;
    return true;
  } catch {
    return false;
  }
}

/**
 * Drawing one annotation stroke, shared by both windows.
 *
 * The overlay paints it live for the person drawing; the engine paints it again
 * into the frame being encoded. They have to agree exactly — a line that lands
 * somewhere other than where it was drawn is worse than no line — so there is
 * one function and both call it.
 *
 * Its own module rather than a shared method on the overlay component: the
 * engine has no UI and no Lit, and importing a `@customElement` to get at a
 * drawing routine would pull the whole component and its dependencies into a
 * bundle that never renders anything.
 *
 * Points are **normalised to the frame**, `0..1` on both axes, so the same
 * stroke draws correctly into the overlay's CSS-pixel canvas and into the
 * encoder's capture-pixel one without either knowing the other's size.
 */

import { strokeCubics } from "@app/features/record/strokeRender";

export type PaintTarget = {
  width: number;
  height: number;
  /** Line width as a fraction of the frame's height. */
  widthN: number;
  alpha: number;
};

/**
 * `CanvasRenderingContext2D` and `OffscreenCanvasRenderingContext2D` are
 * separate types with no common ancestor, and this uses the handful of members
 * they both have. Naming those is more honest than casting one to the other.
 */
type Ctx = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "beginPath"
  | "moveTo"
  | "bezierCurveTo"
  | "arc"
  | "fill"
  | "stroke"
> & {
  globalAlpha: number;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
};

export function paintStroke(
  ctx: Ctx,
  points: readonly { x: number; y: number }[],
  color: string,
  target: PaintTarget,
): void {
  if (points.length === 0) {
    return;
  }

  const at = (point: { x: number; y: number }) => ({
    x: point.x * target.width,
    y: point.y * target.height,
  });

  ctx.save();
  ctx.globalAlpha = target.alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1, target.widthN * target.height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (points.length === 1) {
    // A tap is a dot. Without this the first click of a stroke leaves nothing
    // on screen until the pointer moves.
    const only = at(points[0]);
    ctx.beginPath();
    ctx.arc(only.x, only.y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  // Cubics rather than a polyline, for the reason `features/mask/geometry.ts`
  // gives: an affine transform maps a cubic's control points exactly, so the
  // curve is the same shape at any scale without being re-approximated for it.
  const cubics = strokeCubics(points.map((point) => ({ t: 0, ...point })));
  const start = at(cubics[0].from);

  ctx.beginPath();
  ctx.moveTo(start.x, start.y);

  for (const cubic of cubics) {
    const c1 = at(cubic.c1);
    const c2 = at(cubic.c2);
    const to = at(cubic.to);
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, to.x, to.y);
  }

  ctx.stroke();
  ctx.restore();
}

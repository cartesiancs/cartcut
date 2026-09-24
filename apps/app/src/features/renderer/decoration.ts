/**
 * A border and a drop shadow on the clips that are not text.
 *
 * Text has had both since text effects shipped, under `options.outline` and
 * `options.shadow`, where they stroke the *glyphs*. This is the box version,
 * for a shape, an image or a video: the card border and the soft shadow under
 * it that every design tool calls Stroke and Drop Shadow.
 *
 * Three things it deliberately does not reinvent.
 *
 * **The shadow is `renderer/shadow.ts#paintShadowOnly`.** That function already
 * takes an arbitrary `draw`, already converts element-space offsets and blur
 * through the current matrix, and already uses the push-the-source-off-canvas
 * trick so a shadow pass paints no body. Setting `ctx.shadowBlur` here would be
 * a second, worse copy of all of it.
 *
 * **The path is the clip's real outline.** For a shape that is the same
 * `outlineInBox` the fill traces, so a rounded rectangle's border is rounded
 * and a star's follows its points. Tracing a bounding box instead would be
 * right for exactly one shape kind.
 *
 * **The order is the one `paintLettering` uses**: shadow, then the picture,
 * then the stroke. The stroke goes last so it sits over the edge of the
 * picture rather than under it, which is what makes a border read as a border.
 *
 * One consequence worth stating: a decorated shape issues a fill *and* a
 * stroke, so it stops being a single-draw element. `renderElement`'s fast path
 * checks for that, and the no-surface fallback becomes approximate for a
 * decorated shape exactly as it already is for text.
 */

import type {
  ClipShadow,
  ClipStroke,
  StrokeAlignment,
  TimelineElement,
} from "../../@types/timeline";
import { STROKE_ALIGNMENTS } from "../../@types/timeline";
import { withAlpha } from "../text/style";
import { paintShadowOnly } from "./shadow";

/** Element types that can carry a border and a shadow. */
export const DECORATABLE_FILETYPES = ["shape", "image", "video"] as const;

const DECORATABLE = new Set<string>(DECORATABLE_FILETYPES);

/** Whether a border or a shadow can be set on this element. */
export function isDecoratable(
  element: TimelineElement | null | undefined,
): boolean {
  return element != null && DECORATABLE.has(element.filetype);
}

const ALIGNMENTS = new Set<string>(STROKE_ALIGNMENTS);

/** `#rgb` or `#rrggbb`. What `withAlpha` is able to parse. */
const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Bounds, mirrored by `agent/commands/writable.ts`'s `RANGES`.
 *
 * The blur floor of zero is not cosmetic: the canvas **throws** on a negative
 * `shadowBlur`, and in a paint loop a throw is a blank frame rather than a
 * wrong one.
 */
export const MAX_STROKE_WIDTH = 500;
export const MAX_SHADOW_OFFSET = 1000;
export const MAX_SHADOW_BLUR = 500;

function readNumber(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.min(max, Math.max(min, n));
}

function readColor(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR.test(value) ? value : fallback;
}

/**
 * The stroke in force on an element, or `null`.
 *
 * The read guard. It runs inside the paint loop once per element per frame and
 * must never throw, so every field is defaulted rather than refused — the
 * `normalizeX` half of the split `coerceStroke` completes. A stroke that is
 * switched off, or that has no width, is `null`: both mean "draw nothing", and
 * answering `null` for the second is what keeps the fast path in
 * `renderElement` open for a clip whose border is dialled to zero.
 */
export function strokeOf(
  element: TimelineElement | null | undefined,
): (ClipStroke & { align: StrokeAlignment }) | null {
  const raw = (element as { stroke?: unknown } | null | undefined)?.stroke;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const source = raw as Record<string, unknown>;
  if (source.enable !== true) {
    return null;
  }

  const width = readNumber(source.width, 0, MAX_STROKE_WIDTH) ?? 0;
  if (width <= 0) {
    return null;
  }

  const opacity = readNumber(source.opacity, 0, 100) ?? 100;
  if (opacity <= 0) {
    return null;
  }

  const align =
    typeof source.align === "string" && ALIGNMENTS.has(source.align)
      ? (source.align as StrokeAlignment)
      : "center";

  return {
    enable: true,
    width,
    color: readColor(source.color, "#000000"),
    opacity,
    align,
  };
}

/**
 * The shadow in force on an element, or `null`.
 *
 * The same read guard, and the same "nothing to draw is `null`" rule: a shadow
 * with no blur and no offset would paint a hard copy of the clip exactly
 * underneath it, which is invisible and costs a pass.
 */
export function shadowOf(
  element: TimelineElement | null | undefined,
): ClipShadow | null {
  const raw = (element as { shadow?: unknown } | null | undefined)?.shadow;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const source = raw as Record<string, unknown>;
  if (source.enable !== true) {
    return null;
  }

  const opacity = readNumber(source.opacity, 0, 100) ?? 100;
  if (opacity <= 0) {
    return null;
  }

  const offsetX = readNumber(source.offsetX, -MAX_SHADOW_OFFSET, MAX_SHADOW_OFFSET) ?? 0;
  const offsetY = readNumber(source.offsetY, -MAX_SHADOW_OFFSET, MAX_SHADOW_OFFSET) ?? 0;
  // Floored at zero because the canvas **throws** on a negative `shadowBlur`,
  // which in a paint loop is a blank frame rather than a wrong one.
  const blur = readNumber(source.blur, 0, MAX_SHADOW_BLUR) ?? 0;

  if (offsetX === 0 && offsetY === 0 && blur === 0) {
    return null;
  }

  return {
    enable: true,
    offsetX,
    offsetY,
    blur,
    color: readColor(source.color, "#000000"),
    opacity,
  };
}

/**
 * The write validators, the strict twins of `strokeOf` and `shadowOf`.
 *
 * The asymmetry with the read guards is deliberate and is the whole reason
 * both exist. A read guard answers `null` for a decoration that would paint
 * nothing, because the renderer wants to know whether to open a pass. A write
 * validator answers a **fully populated** value, because a border switched off
 * has to keep the width it had: unchecking a box and checking it again must
 * give back what was there, not the default.
 *
 * `null` here means only "that is not a decoration at all". Every field it can
 * read is clamped, and every field it cannot is defaulted rather than
 * refused — an absent key already means the default, so a junk `width` leaves
 * the border where the user last saw it instead of rejecting the whole write.
 */
export function coerceStroke(value: unknown): ClipStroke | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  return {
    enable: source.enable === true,
    width: readNumber(source.width, 0, MAX_STROKE_WIDTH) ?? 2,
    color: readColor(source.color, "#000000"),
    opacity: readNumber(source.opacity, 0, 100) ?? 100,
    align:
      typeof source.align === "string" && ALIGNMENTS.has(source.align)
        ? (source.align as StrokeAlignment)
        : "center",
  };
}

export function coerceShadow(value: unknown): ClipShadow | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  return {
    enable: source.enable === true,
    offsetX: readNumber(source.offsetX, -MAX_SHADOW_OFFSET, MAX_SHADOW_OFFSET) ?? 0,
    offsetY: readNumber(source.offsetY, -MAX_SHADOW_OFFSET, MAX_SHADOW_OFFSET) ?? 8,
    // Floored at zero because the canvas **throws** on a negative
    // `shadowBlur`, and in a paint loop a throw is a blank frame.
    blur: readNumber(source.blur, 0, MAX_SHADOW_BLUR) ?? 16,
    color: readColor(source.color, "#000000"),
    opacity: readNumber(source.opacity, 0, 100) ?? 40,
  };
}

/** Whether either decoration would paint. */
export function isDecorated(
  element: TimelineElement | null | undefined,
): boolean {
  return strokeOf(element) != null || shadowOf(element) != null;
}

/**
 * Trace a clip's outline onto the current path.
 *
 * `false` means there is nothing to trace, and the caller should draw no
 * decoration at all rather than fall back to a box — a shape whose recipe the
 * renderer does not know draws nothing, and its border must agree.
 *
 * The box branch is right for an image and a video: both are one `drawImage`
 * filling `0,0,width,height`, so their silhouette *is* the box.
 */
export type ClipOutline = {
  trace: (ctx: CanvasRenderingContext2D) => void;
};

/**
 * The outline of a clip that fills its box.
 *
 * An image and a video are each one `drawImage` over `0,0,width,height`, so
 * their silhouette *is* the box. A shape has a real outline and traces that
 * instead; see `renderer/shape.ts#shapeOutlineOf`.
 */
export function boxOutline(width: number, height: number): ClipOutline {
  return {
    trace: (ctx) => {
      ctx.rect(0, 0, width, height);
    },
  };
}

/**
 * Paint a clip's decoration around `drawPicture`.
 *
 * `outline` traces the silhouette; it is called several times and must leave
 * the same path each time.
 */
export function paintDecoration(
  ctx: CanvasRenderingContext2D,
  element: TimelineElement,
  outline: ClipOutline,
  drawPicture: () => void,
): void {
  const shadow = shadowOf(element);
  const stroke = strokeOf(element);

  if (shadow == null && stroke == null) {
    drawPicture();
    return;
  }

  if (shadow != null) {
    // Cast from the outline rather than from the picture: an image with
    // transparency would otherwise cast a shadow with holes in it, which is a
    // different effect and not the one a card wants. The stroke is included
    // when it sits outside, because that is the edge the eye reads.
    const cast = () => {
      ctx.beginPath();
      outline.trace(ctx);
      ctx.fillStyle = "#000000";
      ctx.fill();
      if (stroke != null && stroke.align !== "inner") {
        ctx.lineWidth =
          stroke.align === "outer" ? stroke.width * 2 : stroke.width;
        ctx.strokeStyle = "#000000";
        ctx.stroke();
      }
    };

    paintShadowOnly(ctx, cast, {
      offsetX: shadow.offsetX,
      offsetY: shadow.offsetY,
      blur: shadow.blur,
      color: withAlpha(shadow.color, shadow.opacity),
    });
  }

  drawPicture();

  if (stroke != null) {
    paintStroke(ctx, outline, stroke);
  }
}

/**
 * Stroke an outline, honouring the alignment.
 *
 * The canvas strokes **centred** and offers no choice about it: half the line
 * falls inside the shape and half outside. The other two alignments are built
 * by stroking at twice the width and clipping away the half that does not
 * belong, which is exact rather than approximate — a 2w centred stroke covers
 * exactly `[-w, +w]` about the outline, so clipping to one side leaves exactly
 * `w` of it.
 *
 *  - `inner` clips to the shape.
 *  - `outer` clips to everything *but* the shape, by tracing the visible
 *    region and the outline into one path and filling `evenodd`. The visible
 *    region is the canvas mapped back into element space, so it is bounded and
 *    correct under any zoom — a hard-coded huge rectangle would lose precision
 *    under a scaled-up clip, which is exactly when a border is being examined.
 *
 * `destination-out` is not used. It erases what is already on the surface, and
 * the picture is beneath the stroke by the time this runs.
 */
function paintStroke(
  ctx: CanvasRenderingContext2D,
  outline: ClipOutline,
  stroke: ClipStroke & { align: StrokeAlignment },
): void {
  const color = withAlpha(stroke.color, stroke.opacity);

  ctx.save();

  if (stroke.align === "inner") {
    ctx.beginPath();
    outline.trace(ctx);
    ctx.clip();
  } else if (stroke.align === "outer") {
    const visible = visibleRect(ctx);
    if (visible != null) {
      ctx.beginPath();
      ctx.rect(visible.x, visible.y, visible.w, visible.h);
      outline.trace(ctx);
      // Even-odd, so the shape punches a hole in the rectangle whichever way
      // its subpaths are wound. A star and a ring both have to work here.
      ctx.clip("evenodd");
    }
  }

  ctx.beginPath();
  outline.trace(ctx);
  ctx.lineWidth =
    stroke.align === "center" ? stroke.width : stroke.width * 2;
  ctx.strokeStyle = color;
  ctx.stroke();

  ctx.restore();
}

/**
 * The canvas, in the element's own coordinates.
 *
 * `null` for a degenerate matrix — a clip scaled to nothing, which covers no
 * pixels and needs no border. The box is padded by a whole extra copy of
 * itself so a rounding error at the edge cannot clip the stroke short.
 */
function visibleRect(
  ctx: CanvasRenderingContext2D,
): { x: number; y: number; w: number; h: number } | null {
  let inverse: DOMMatrix;
  try {
    inverse = ctx.getTransform().inverse();
  } catch {
    return null;
  }

  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const corners = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ].map(([x, y]) => ({
    x: inverse.a * x + inverse.c * y + inverse.e,
    y: inverse.b * x + inverse.d * y + inverse.f,
  }));

  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    return null;
  }

  const padX = maxX - minX;
  const padY = maxY - minY;
  return {
    x: minX - padX,
    y: minY - padY,
    w: (maxX - minX) * 3,
    h: (maxY - minY) * 3,
  };
}

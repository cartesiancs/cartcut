/**
 * What the pointer is over, in the element's own coordinate space.
 *
 * The version this replaces lived inside `previewCanvas.collisionCheck` and
 * un-rotated the pointer by hand, reading `element.rotation` directly. That was
 * a second, independent answer to "where is this element" — the exact hazard
 * the header of `elementPosition.ts` documents — and it was already incomplete:
 * it knew about rotation but not about scale, because until now nothing could
 * scale an element except its own `scale` track, which the check ignored.
 *
 * With groups, an element can be rotated *and* scaled by an ancestor it has
 * never heard of. So the un-rotation is gone; the caller inverts the element's
 * world matrix — the same matrix the renderer draws with — and hands the
 * pointer in already in local space. This function then only has to answer a
 * question about an axis-aligned rectangle at the origin.
 *
 * Kept DOM-free so it runs in the `node` suite alongside the timeline modules.
 */

import type { Point } from "../timeline/transform";

export type HitZone =
  | "position"
  | "rotation"
  | "stretchE"
  | "stretchW"
  | "stretchN"
  | "stretchS"
  | "stretchNW"
  | "stretchNE"
  | "stretchSW"
  | "stretchSE"
  | "none";

/** Half-width of the grab band around an edge, in screen pixels. */
export const HANDLE_PADDING_PX = 20;

/** The rotation knob's box above the top edge, in screen pixels. */
export const ROTATION_HANDLE_HALF_WIDTH_PX = 25;
export const ROTATION_HANDLE_HEIGHT_PX = 75;

export type HitTestOptions = {
  /** Grab band around the edges. Defaults to `HANDLE_PADDING_PX`. */
  padding?: number;
  /**
   * The uniform scale the element's world matrix applies.
   *
   * Handle sizes are a property of the *pointer*, not of the artwork: a corner
   * grip should be the same number of screen pixels whatever the element is
   * doing. Since the point arriving here has already been divided by this
   * scale, the bands have to be divided too — otherwise a child inside a group
   * scaled to 25% gets grips a quarter their intended size and becomes
   * effectively unusable, and one inside a group scaled to 400% gets grips so
   * fat they swallow the element.
   */
  worldScale?: number;
};

/**
 * Which zone `local` falls in for a `w × h` box whose top-left is the origin.
 *
 * Order matters and matches what the pointer expects: the interior wins over
 * the edges, so a drag started well inside a small element moves it rather than
 * resizing it; corners win over edges, since a corner is inside both bands.
 */
export function hitZoneOf(
  local: Point,
  w: number,
  h: number,
  options: HitTestOptions = {},
): HitZone {
  const scale = normaliseScale(options.worldScale);
  // Grips shrink for a small element rather than swallowing it.
  //
  // Without the clamp the bands overlap once `padding` passes half a side, and
  // the interior test `x > p/2 && x < w - p/2` becomes an empty range — so a
  // 20×20 clip, or any clip inside a group scaled well down, could not be
  // grabbed to move at all: every point on it reported a resize grip. A third
  // of the shorter side leaves the interior at least a third of the element and
  // keeps the four edge bands disjoint.
  const requested = (options.padding ?? HANDLE_PADDING_PX) / scale;
  const padding = Math.max(
    0,
    Math.min(requested, Math.abs(w) / 3, Math.abs(h) / 3),
  );
  const knobHalfWidth = ROTATION_HANDLE_HALF_WIDTH_PX / scale;
  const knobHeight = ROTATION_HANDLE_HEIGHT_PX / scale;

  const { x, y } = local;

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return "none";
  }

  // Interior first. `padding / 2` rather than `padding` so that a click just
  // inside an edge still moves the element — the resize bands straddle the
  // edge, and the inner half of one is shared with the body.
  if (
    x > padding / 2 &&
    x < w - padding / 2 &&
    y > padding / 2 &&
    y < h - padding / 2
  ) {
    return "position";
  }

  const nearW = x > -padding && x < padding;
  const nearE = x > w - padding && x < w + padding;
  const nearN = y > -padding && y < padding;
  const nearS = y > h - padding && y < h + padding;

  // Corners before edges: a corner point satisfies two edge bands at once, and
  // a diagonal resize is what the user aimed at.
  if (nearW && nearN) return "stretchNW";
  if (nearE && nearN) return "stretchNE";
  if (nearW && nearS) return "stretchSW";
  if (nearE && nearS) return "stretchSE";

  const insideVertically = y > padding && y < h - padding;
  const insideHorizontally = x > padding && x < w - padding;

  if (nearE && insideVertically) return "stretchE";
  if (nearW && insideVertically) return "stretchW";
  if (nearN && insideHorizontally) return "stretchN";
  if (nearS && insideHorizontally) return "stretchS";

  // The rotation knob sits above the top edge, outside the box entirely, so it
  // is tested last — nothing inside the element can reach it.
  if (
    x > w / 2 - knobHalfWidth &&
    x < w / 2 + knobHalfWidth &&
    y > -knobHeight &&
    y < 0
  ) {
    return "rotation";
  }

  return "none";
}

/** Whether a zone is one of the eight resize grips. */
export function isStretchZone(zone: HitZone): boolean {
  return zone.startsWith("stretch");
}

/**
 * A guard against a scale of zero or worse.
 *
 * The scale track can reach 0, and dividing the handle sizes by it would make
 * every band infinite — so every pointer position would report a corner grab.
 */
function normaliseScale(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) {
    return 1;
  }
  return raw;
}

/**
 * The null object's on-canvas gizmo — its shape and what the pointer may grab.
 *
 * A null (`GroupElementType`, born from `createNullElement`) paints nothing:
 * `isVisualTimelineElement` drops it from the paint loop and `renderElement`
 * has no renderer for it. Its `width`/`height` are a *pivot*, not a picture.
 * So the only way it can be seen or held is as chrome drawn beside the scene,
 * and this module is the definition of that chrome.
 *
 * ## Why the shape and the hit test live in one file
 *
 * The rule this repo keeps restating — `transform.ts`'s header, `hitTest.ts`'s
 * header, `previewCanvas.hitZoneAt`'s comment — is that drawing and pointing
 * must not be able to ask separately. `nullGizmoGeometry` answers "where is
 * every mark" and `nullHitZoneOf` answers "what is under the pointer", and they
 * derive every length from the same constants and the same `worldScale`. A grip
 * drawn where nothing can be grabbed is the `collisionCheck` bug over again.
 *
 * This is also why `renderControlOutline` is *not* reused here. That function
 * measures its handles in **world** pixels (`padding = 10`), while every hit
 * test measures in **screen** pixels divided by the world scale. The two
 * already disagree for ordinary clips — a known wart, visible as grips that
 * shrink when you zoom out — and a null, whose entire visible existence is its
 * handles, cannot afford to inherit it.
 *
 * ## The interior is not part of the null
 *
 * `nullHitZoneOf` answers `"none"` anywhere inside the box that is not the
 * anchor. That is the whole reason a null can be drawn all the time without
 * ruining the preview: a null's box typically *encloses its own children*, so a
 * null that answered the pointer across its full rectangle would be an
 * invisible sheet swallowing every click aimed at what is inside it — the
 * hazard `previewCanvas.isPointerTarget` used to avoid by making a group
 * unclickable until it was already selected, which was circular and meant a
 * null could never be selected at all.
 *
 * Pure and DOM-free, so it runs in the `node` suite beside `hitTest.ts`.
 */

import type { Point } from "../timeline/transform";
import type { Timeline } from "../../@types/timeline";
import {
  ROTATION_HANDLE_HALF_WIDTH_PX,
  ROTATION_HANDLE_HEIGHT_PX,
  type HitZone,
} from "./hitTest";

/**
 * Half-width of the band along an edge that belongs to the null.
 *
 * Narrower than a clip's `HANDLE_PADDING_PX` of 20 on purpose: a clip's band
 * straddles an edge you can see filled in behind it, while a null's band is the
 * only thing there, and 20px of invisible margin around a frame-sized null is a
 * lot of preview to make unclickable.
 */
export const NULL_BAND_PX = 8;

/** The drawn anchor ring. */
export const NULL_ANCHOR_RADIUS_PX = 6;
/** Arm length of the drawn anchor crosshair, from the centre. */
export const NULL_ANCHOR_ARM_PX = 11;
/**
 * Grab radius of the anchor, and deliberately larger than the drawn ring.
 *
 * The anchor is the primary target — it is how a null is moved — so it is worth
 * a few pixels of slop. It stays under the crosshair's arms, so the generous
 * region is still one the user can see.
 */
export const NULL_ANCHOR_GRAB_PX = 12;

/** Half-size of the filled corner square shown while the null is selected. */
export const NULL_GRIP_PX = 5;
/** Stroke width of every line in the gizmo. */
export const NULL_LINE_PX = 1.5;
/** Radius of the rotation knob, centred inside the zone `hitZoneOf` defines. */
export const NULL_KNOB_RADIUS_PX = 8;
/** How far above the top edge the knob's centre sits. */
export const NULL_KNOB_OFFSET_PX = 50;

/**
 * How the gizmo is being looked at.
 *
 * Three states rather than two because a null is drawn *all the time*: `idle`
 * has to be quiet enough that several nulls do not bury the picture, and a
 * target that quiet needs a `hover` state to say what is about to be grabbed.
 */
export type NullGizmoState = "idle" | "hover" | "active";

export type NullGizmoGeometry = {
  /** The pivot box, element-local. Always the sampled box, never the stored one. */
  w: number;
  h: number;
  /**
   * Element-local pixels to one screen pixel — i.e. `1 / worldScale`.
   *
   * Carried rather than left for the renderer to recover from one of the
   * lengths below, so anything the gizmo needs to size in screen terms and
   * this module has no constant for — a font, say — measures from the same
   * number as everything else.
   */
  unit: number;
  /** Half-width of the edge/corner grab band, element-local. */
  band: number;
  /** Corner tick arm length. Always `band` — see `nullGizmoGeometry`. */
  tick: number;
  /** Half-size of the selected-state corner grip, element-local. */
  grip: number;
  /** Stroke width, element-local. */
  line: number;
  /** The pivot, and the sizes of the marks on it. */
  anchor: { x: number; y: number; radius: number; arm: number; grab: number };
  /** The rotation knob's drawn circle. */
  knob: { x: number; y: number; radius: number };
};

/**
 * A guard against a scale of zero or worse.
 *
 * The scale track reaches 0, and dividing by it would make every band infinite
 * — so every point in the preview would report a corner grab on the null. The
 * same defence `hitTest.normaliseScale` states, for the same reason.
 */
function normaliseScale(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) {
    return 1;
  }
  return raw;
}

/**
 * Every mark on the gizmo, in the element's own pixels.
 *
 * `worldScale` is how many element pixels there are to one screen pixel — the
 * element's own world scale times the preview's zoom, which is what
 * `previewCanvas.penScreenUnit` already computes for the pen's chrome. Dividing
 * by it is what keeps the gizmo the same size on screen at every zoom and
 * inside a group scaled to any factor.
 */
export function nullGizmoGeometry(
  w: number,
  h: number,
  worldScale: number,
): NullGizmoGeometry {
  const scale = normaliseScale(worldScale);
  const shorter = Math.min(Math.abs(w), Math.abs(h));

  // Clamped against the box, so a null that is tiny on screen keeps an interior
  // for clicks to fall through and an anchor to aim at. Without the clamp the
  // four bands meet in the middle and the null becomes the swallowing sheet
  // this module exists to avoid. A quarter of the shorter side leaves the
  // bands disjoint and the middle half of each axis free.
  const band = Math.max(0, Math.min(NULL_BAND_PX / scale, shorter / 4));

  // The corner tick's arms are exactly the corner band, not a length of their
  // own. A longer arm looked better and lied: the corner zone is a square of
  // half-width `band` around the corner, so an arm reaching past it drew a mark
  // saying "corner" over a point the hit test answers `stretchN` for. Deriving
  // it makes that impossible rather than merely tested.
  const tick = band;

  return {
    w,
    h,
    unit: 1 / scale,
    band,
    tick,
    grip: NULL_GRIP_PX / scale,
    line: NULL_LINE_PX / scale,
    anchor: {
      x: w / 2,
      y: h / 2,
      radius: NULL_ANCHOR_RADIUS_PX / scale,
      arm: NULL_ANCHOR_ARM_PX / scale,
      grab: NULL_ANCHOR_GRAB_PX / scale,
    },
    knob: {
      x: w / 2,
      y: -NULL_KNOB_OFFSET_PX / scale,
      radius: NULL_KNOB_RADIUS_PX / scale,
    },
  };
}

/**
 * Which part of a null's gizmo the element-local point `local` is over.
 *
 * The caller inverts the element's world matrix first, exactly as
 * `previewCanvas.hitZoneAt` does for a clip, so rotation, scale, animation and
 * every ancestor group are already accounted for.
 *
 * Order is the design:
 *
 *   1. **The anchor first.** It is how the null is moved, it is the smallest
 *      target, and on a null that is small on screen it overlaps the bands. Any
 *      other order would make a small null unmovable.
 *   2. Corners before edges — a corner point satisfies two edge bands, and the
 *      diagonal is what was aimed at. The same rule `hitZoneOf` follows.
 *   3. The rotation knob, which sits outside the box entirely.
 *   4. **Everything else is `"none"`, the interior included.**
 */
export function nullHitZoneOf(
  local: Point,
  w: number,
  h: number,
  options: { worldScale?: number } = {},
): HitZone {
  const { x, y } = local;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return "none";
  }

  const scale = normaliseScale(options.worldScale);
  const g = nullGizmoGeometry(w, h, scale);

  if (Math.hypot(x - g.anchor.x, y - g.anchor.y) <= g.anchor.grab) {
    return "position";
  }

  const band = g.band;
  const nearW = x >= -band && x <= band;
  const nearE = x >= w - band && x <= w + band;
  const nearN = y >= -band && y <= band;
  const nearS = y >= h - band && y <= h + band;

  if (nearW && nearN) return "stretchNW";
  if (nearE && nearN) return "stretchNE";
  if (nearW && nearS) return "stretchSW";
  if (nearE && nearS) return "stretchSE";

  // Inside the *other* axis' span, so a point far off the end of an edge is a
  // miss rather than an edge grab.
  const alongX = x > band && x < w - band;
  const alongY = y > band && y < h - band;

  if (nearE && alongY) return "stretchE";
  if (nearW && alongY) return "stretchW";
  if (nearN && alongX) return "stretchN";
  if (nearS && alongX) return "stretchS";

  // The same zone a clip's knob occupies, from the same two constants, so the
  // knob is in the place the user has learnt it is. The drawn circle sits
  // inside this box; the box is deliberately the larger of the two.
  const knobHalfWidth = ROTATION_HANDLE_HALF_WIDTH_PX / scale;
  const knobHeight = ROTATION_HANDLE_HEIGHT_PX / scale;
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

/**
 * The order the pointer sweeps the timeline in, groups last.
 *
 * Both pointer loops in `previewCanvas` walk every element and **never break**,
 * so the last match wins — which is what puts the topmost clip on top. A group
 * row carries no z-order meaning (`tracks.ts#defaultTrackKindFor` says so), so
 * a null's `priority` is arbitrary relative to the pictures it sits over, and
 * left in `priority` order a null would be grabbable or not depending on where
 * its row happened to land.
 *
 * Sorting groups to the end settles that: the gizmo is chrome, and chrome wins.
 * It costs the clips underneath almost nothing, because a null only ever claims
 * its thin bands and its anchor — never its interior.
 */
export function pointerOrder(timeline: Timeline): string[] {
  return Object.keys(timeline).sort((a, b) => {
    const ga = timeline[a]?.filetype === "group" ? 1 : 0;
    const gb = timeline[b]?.filetype === "group" ? 1 : 0;
    if (ga !== gb) {
      return ga - gb;
    }
    return (timeline[a]?.priority ?? 0) - (timeline[b]?.priority ?? 0);
  });
}

/**
 * Drawing the null object's gizmo.
 *
 * Every length comes from `nullGizmoGeometry`; there is no arithmetic here.
 * That is the point — `features/preview/nullGizmo.ts` owns the shape *and* the
 * hit test, so a mark drawn by this file is always a mark the pointer accepts,
 * and the pair cannot drift the way `renderControlOutline` and `hitZoneOf`
 * have.
 *
 * The caller has already applied the parent chain and the element's own local
 * transform — the same two steps `renderElement` takes — so everything below is
 * drawn in the element's own space with its box's top-left at the origin.
 *
 * This is **preview chrome and nothing else.** It must never be reachable from
 * `renderTimelineAtTime`, which the in-app export, the offscreen export window,
 * the agent's contact sheet and the e2e reference render all share: a gizmo
 * drawn there would be baked into the delivered file.
 *
 * ## What each state draws
 *
 * ```
 * idle     the anchor
 * hover    the anchor, the dashed box, the corner ticks, the name
 * active   all of that, the eight grips and the rotation knob
 * ```
 *
 * The ladder is the answer to a null being drawn at every playhead, and it is
 * After Effects' and Premiere's: transform chrome belongs to what the user is
 * working on, not to the picture. `drawNullGizmo` says where we part company
 * with them and why the unmarked grab bands are safe.
 */

import type {
  NullGizmoGeometry,
  NullGizmoState,
} from "../preview/nullGizmo";

/** How visible the gizmo is in each state. */
const ALPHA: Record<NullGizmoState, number> = {
  // Quiet enough that a project with several nulls is still watchable, strong
  // enough to find. A null is drawn at every playhead, so this number is the
  // difference between an affordance and a nuisance. It applies to the anchor
  // alone now: see `drawNullGizmo` for why idle draws nothing else.
  idle: 0.55,
  hover: 1,
  active: 1,
};

/** The label's height in screen pixels, before the world scale is divided out. */
const LABEL_PX = 11;

/**
 * The dark backing every mark is laid over, and how far past it it stands.
 *
 * Premiere's program-monitor handles and After Effects' anchor point are both
 * two-tone, and here that is load-bearing rather than decoration: `color` is
 * the user's own `timelineOptions.color`, the footage under it is anything at
 * all, and at `idle` the anchor is the only mark there is. A single-tone
 * crosshair the same value as the shot it sits on is a null nobody can find,
 * and the outline is what lets `ALPHA.idle` stay this low over both a white
 * sky and a black one.
 *
 * Measured in screen pixels like every other constant here, so it is divided
 * by the world scale before use and does not thicken as the preview zooms.
 */
const HALO_COLOR = "rgba(0, 0, 0, 0.6)";
/**
 * Half a pixel, and the ceiling is lower than it looks. The anchor is a ring
 * of radius 6 with arms crossing it, so the four wedges between them are only
 * a few pixels wide; at 1 the backing closes them and a 22px crosshair reads
 * as a dark blob. Compared at 8x over light, mid and dark footage.
 */
const HALO_PX = 0.5;

/**
 * Draw one null's gizmo at the origin of the current transform.
 *
 * `color` is the null's own `timelineOptions.color`, which `createNullElement`
 * seeds and the timeline bar already paints with — so a null looks the same in
 * both places, and two nulls are told apart the same way in both.
 */
export function drawNullGizmo(
  ctx: CanvasRenderingContext2D,
  geometry: NullGizmoGeometry,
  state: NullGizmoState,
  color: string,
  label?: string,
): void {
  const { w, h, tick, line, grip, anchor, knob, unit } = geometry;

  ctx.save();
  ctx.globalAlpha = ALPHA[state];
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";

  // How far the backing stands out past the mark it backs, in element pixels.
  const out = HALO_PX * unit;

  /**
   * Every mark, once as its dark backing and once in the null's own colour.
   *
   * One function called twice rather than two: a backing that traced a
   * different path from the mark would be a halo with a gap in it, and the
   * only way to make that impossible is for there to be one description of
   * where the marks are.
   */
  const paint = (backing: boolean) => {
    ctx.strokeStyle = backing ? HALO_COLOR : color;
    ctx.fillStyle = backing ? HALO_COLOR : color;
    // Widened on both sides, so the mark drawn next sits centred on it.
    const stroke = (base: number) => {
      ctx.lineWidth = backing ? base + 2 * out : base;
    };
    // Filled marks grow instead, which leaves the same rim showing.
    const pad = backing ? out : 0;

    // The boundary, and everything that marks it, is withheld at idle.
    //
    // This is After Effects' and Premiere's rule: transform chrome belongs to
    // whatever the user is working on. AE draws a null's box, its handles and
    // its anchor only while the layer is selected, and Premiere's program
    // monitor shows the Motion handles only for the clip in the Effect
    // Controls panel. Neither leaves a rectangle standing over the picture.
    //
    // We cannot go the whole way, because unlike AE we have no layer list that
    // can select a null the preview refuses to hand over, and a box drawn at
    // every playhead for every null is a frame-sized dashed rectangle sitting
    // on top of the shot it is parenting. So the resting state keeps the
    // anchor and drops the outline: one mark, at a point, instead of a border
    // around the whole picture.
    //
    // The bands stay grabbable while unmarked, which is the one thing to be
    // careful about. `previewCanvas._handleMouseMove` sets `gizmoHoverId` for
    // *any* zone `nullHitZoneOf` answers, the edges and the knob included, so
    // the boundary appears the instant the pointer is on it and the cursor
    // changes with it. Reveal on approach, and still more discoverable than
    // Premiere, where the same handles are not there at all until the clip is
    // selected.
    if (state !== "idle") {
      // Dashed rather than solid for the reason the old
      // `ControlOutlineStyle.dashed` gave: a solid rectangle claims there are
      // pixels inside it, and a null has none. A dash says "boundary", which
      // is what every design tool uses for a frame or a guide.
      const dash = Math.max(line * 3, Math.min(Math.abs(w), Math.abs(h)) / 24);
      stroke(line);
      ctx.setLineDash([dash, dash]);
      ctx.strokeRect(0, 0, w, h);
      ctx.setLineDash([]);

      // The corner ticks: an L at each corner, drawn along the two bands that
      // corner answers for. They are the visible form of the corner grab zone.
      if (tick > 0) {
        stroke(line * 2);
        const corner = (cx: number, cy: number, sx: number, sy: number) => {
          ctx.beginPath();
          ctx.moveTo(cx + sx * tick, cy);
          ctx.lineTo(cx, cy);
          ctx.lineTo(cx, cy + sy * tick);
          ctx.stroke();
        };
        corner(0, 0, 1, 1);
        corner(w, 0, -1, 1);
        corner(w, h, -1, -1);
        corner(0, h, 1, -1);
      }
    }

    // The anchor: a crosshair through a ring, on the pivot everything about
    // this null rotates and scales about. It is the primary grab target, and
    // the only part of the interior the pointer answers for, so it is the one
    // mark that has to be findable without hovering. At idle it is the *whole*
    // gizmo, which is also what AE draws for an anchor point and roughly the
    // size AE draws it.
    stroke(line);
    ctx.beginPath();
    ctx.moveTo(anchor.x - anchor.arm, anchor.y);
    ctx.lineTo(anchor.x + anchor.arm, anchor.y);
    ctx.moveTo(anchor.x, anchor.y - anchor.arm);
    ctx.lineTo(anchor.x, anchor.y + anchor.arm);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(anchor.x, anchor.y, anchor.radius, 0, Math.PI * 2);
    ctx.stroke();

    if (state === "active") {
      // The eight grips and the knob, each sitting *on* a band the hit test
      // already accepts. Nothing new becomes grabbable by selecting a null:
      // the grips only make visible what was answering the pointer all along,
      // which is what keeps one rule for both states.
      const square = (cx: number, cy: number) => {
        ctx.fillRect(
          cx - grip - pad,
          cy - grip - pad,
          (grip + pad) * 2,
          (grip + pad) * 2,
        );
      };
      square(0, 0);
      square(w, 0);
      square(w, h);
      square(0, h);
      square(w / 2, 0);
      square(w / 2, h);
      square(0, h / 2);
      square(w, h / 2);

      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(knob.x, knob.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(knob.x, knob.y, knob.radius + pad, 0, Math.PI * 2);
      ctx.fill();
    }

    // The name, only once the pointer has said which null it means. Drawn at
    // every playhead for every null, a permanent label would be the clutter
    // idle is trying to avoid, and it is only needed to tell two nulls apart,
    // which is a question you ask about the one you are pointing at.
    if (label != null && label !== "" && state !== "idle") {
      ctx.font = `${LABEL_PX * unit}px sans-serif`;
      ctx.textBaseline = "bottom";
      const x = 0;
      const y = -6 * unit;
      if (backing) {
        // Rounded, or every glyph's sharp corners grow spikes past the letter.
        ctx.lineJoin = "round";
        ctx.lineWidth = 3 * out;
        ctx.strokeText(label, x, y);
        ctx.lineJoin = "miter";
      } else {
        ctx.fillText(label, x, y);
      }
    }
  };

  paint(true);
  paint(false);

  ctx.restore();
}

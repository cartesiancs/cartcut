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
 */

import type {
  NullGizmoGeometry,
  NullGizmoState,
} from "../preview/nullGizmo";

/** How visible the gizmo is in each state. */
const ALPHA: Record<NullGizmoState, number> = {
  // Quiet enough that a project with several nulls is still watchable, strong
  // enough to find. A null is drawn at every playhead, so this number is the
  // difference between an affordance and a nuisance.
  idle: 0.55,
  hover: 1,
  active: 1,
};

/** The label's height in screen pixels, before the world scale is divided out. */
const LABEL_PX = 11;

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
  const { w, h, tick, line, grip, anchor, knob } = geometry;

  ctx.save();
  ctx.globalAlpha = ALPHA[state];
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = line;
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";

  // The box, dashed. Dashed rather than solid for the reason the old
  // `ControlOutlineStyle.dashed` gave: a solid rectangle claims there are
  // pixels inside it, and a null has none. A dash says "boundary", which is
  // what every design tool uses for a frame or a guide.
  const dash = Math.max(line * 3, Math.min(Math.abs(w), Math.abs(h)) / 24);
  ctx.setLineDash([dash, dash]);
  ctx.strokeRect(0, 0, w, h);
  ctx.setLineDash([]);

  // The corner ticks: an L at each corner, drawn along the two bands that
  // corner answers for. They are the visible form of the corner grab zone.
  if (tick > 0) {
    ctx.lineWidth = line * 2;
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
    ctx.lineWidth = line;
  }

  // The anchor: a crosshair through a ring, on the pivot everything about this
  // null rotates and scales about. It is the primary grab target, and the only
  // part of the interior the pointer answers for — so it is the one mark that
  // has to be findable without hovering.
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
    // already accepts. Nothing new becomes grabbable by selecting a null — the
    // grips only make visible what was answering the pointer all along, which
    // is what keeps one rule for both states.
    const square = (cx: number, cy: number) => {
      ctx.fillRect(cx - grip, cy - grip, grip * 2, grip * 2);
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
    ctx.arc(knob.x, knob.y, knob.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // The name, only once the pointer has said which null it means. Drawn at
  // every playhead for every null, a permanent label would be the clutter the
  // `idle` alpha is trying to avoid — and it is only needed to tell two nulls
  // apart, which is a question you ask about the one you are pointing at.
  if (label != null && label !== "" && state !== "idle") {
    ctx.font = `${LABEL_PX * geometry.unit}px sans-serif`;
    ctx.textBaseline = "bottom";
    ctx.fillText(label, 0, -6 * geometry.unit);
  }

  ctx.restore();
}

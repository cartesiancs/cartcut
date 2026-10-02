/**
 * The selection outline for a **clip**.
 *
 * It used to carry a `dashed` option, and a pivot dot under it, for the one
 * caller that passed a group. Groups are drawn by
 * `features/renderer/nullGizmo.ts` now, from the same geometry their hit test
 * uses.
 *
 * ## Every size is in screen pixels
 *
 * The caller draws in the element's own space, so `unit` says how many of its
 * pixels make one screen pixel: one over the element's world scale times the
 * preview's zoom. Every length below is multiplied by it, so the grips, the
 * line and the knob are the same size on screen at every zoom and at every
 * scale a parent group applies. They used to be fixed in project pixels, which
 * made them grow as you zoomed in and shrink to nothing as you zoomed out, while
 * the bands `preview/hitTest.ts` answers for stayed put: a grip you could see
 * that you could not grab, or one you could grab that you could not see.
 *
 * The knob sits inside `ROTATION_HANDLE_*` and the grips inside
 * `HANDLE_PADDING_PX`, both in screen pixels; `controlOutline.test.ts` holds
 * that, so the two cannot drift apart again.
 *
 * ## Every mark is drawn twice
 *
 * A white outline on a white clip is not faint — it is *gone*, and with it the
 * only thing on screen saying the element is selected and where its corners
 * are. Every editor solves this the same way and none of them solves it by
 * sampling the backdrop: the handles are one bright mark sitting on a darker
 * **casing** a pixel or two wider, so one of the two always contrasts. Premiere
 * and Resolve draw a black rim around a white handle, After Effects a black
 * border around its squares, Figma a coloured border around a white one. The
 * mark stays the same colour whatever is behind it, so nothing about it flickers
 * as the clip moves over a light or dark region.
 *
 * Sampling the picture underneath and inverting is the alternative, and it is
 * wrong here twice: the value under a handle changes every frame during
 * playback, so the chrome would strobe; and it costs a `getImageData` per
 * handle per repaint on the thread already compositing the preview.
 *
 * `difference` blending — Photoshop's marching ants — is the other classic and
 * fails on mid grey, which is exactly the backdrop a video preview usually is.
 *
 * So: `RIM_PX` of `CASING` around everything, drawn as a first pass under the
 * whole mark rather than per shape, which keeps the two passes from cutting
 * into each other where the box stroke meets a grip.
 */
export type ControlOutlineStyle = {
  color?: string;
  /** The contrast pass under `color`. Pass `"transparent"` to suppress it. */
  casing?: string;
  /**
   * How many of the current transform's units make one screen pixel. Defaults
   * to 1, where every size below is taken literally.
   */
  unit?: number;
};

/** The bright mark. */
const MARK = "#ffffff";
/**
 * The casing under it. Black at 62% rather than opaque: it has to read as a
 * rim on the mark, not as a second outline of its own, and on a dark backdrop
 * an opaque one would be the widest thing on screen.
 */
const CASING = "rgba(0, 0, 0, 0.62)";
/**
 * How far the casing stands out past the mark. Half the line width, so it reads
 * as a rim without thickening the outline itself.
 */
export const RIM_PX = 0.75;

export const LINE_WIDTH_PX = 1.5;
/** Half-size of a corner grip, and the unit the edge bars are derived from. */
export const GRIP_PX = 4;
/** The rotation knob: how far above the box its centre sits, and how big. */
export const KNOB_OFFSET_PX = 20;
export const KNOB_RADIUS_PX = 6;

export function renderControlOutline(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  style: ControlOutlineStyle = {},
) {
  ctx.save();

  ctx.globalAlpha = 1;

  // A unit of zero or less would collapse every mark to a point, or flip it.
  const unit = style.unit != null && style.unit > 0 ? style.unit : 1;
  const padding = GRIP_PX * unit;
  const rim = RIM_PX * unit;

  // Edge grips. The hit test has offered `stretchN/S/E/W` all along, but
  // nothing drew them, so the one gesture that resizes a single axis was
  // invisible — the reason a shape appeared to only scale.
  //
  // Bars rather than squares: the corners are squares and take both axes at
  // once, so a matching square at a midpoint would claim to do the same. A bar
  // lying along its edge says "this one axis" without a legend, which is the
  // vocabulary every editor uses.
  const barThickness = padding * 0.6;
  // Capped against the side it sits on, so on a narrow box the bar cannot run
  // into the corner grips and turn the whole edge into one continuous block.
  const barLength = (side: number) =>
    Math.min(padding * 2.4, side - padding * 2.6);
  const hBar = barLength(w);
  const vBar = barLength(h);

  /**
   * One whole pass of the outline, every mark fattened by `grow`.
   *
   * The casing is this same drawing with `grow = rim`, which is what keeps the
   * two in step: a mark added below gets its rim for free, and a bar the cap
   * above suppresses is suppressed in both passes — the `bw > 0` test reads the
   * *ungrown* size so a casing can never appear under a mark that is not there.
   */
  const pass = (grow: number, paint: string) => {
    ctx.strokeStyle = paint;
    ctx.fillStyle = paint;

    ctx.lineWidth = LINE_WIDTH_PX * unit + grow * 2;
    ctx.strokeRect(x, y, w, h);

    const square = (cx: number, cy: number) => {
      const half = padding + grow;
      ctx.beginPath();
      ctx.rect(cx - half, cy - half, half * 2, half * 2);
      ctx.fill();
    };
    square(x, y);
    square(x + w, y);
    square(x + w, y + h);
    square(x, y + h);

    const drawBar = (cx: number, cy: number, bw: number, bh: number) => {
      if (!(bw > 0) || !(bh > 0)) {
        return;
      }
      ctx.beginPath();
      ctx.rect(
        cx - bw / 2 - grow,
        cy - bh / 2 - grow,
        bw + grow * 2,
        bh + grow * 2,
      );
      ctx.fill();
    };

    drawBar(x + w / 2, y, hBar, barThickness);
    drawBar(x + w / 2, y + h, hBar, barThickness);
    drawBar(x, y + h / 2, barThickness, vBar);
    drawBar(x + w, y + h / 2, barThickness, vBar);

    //draw control rotation

    ctx.beginPath();
    ctx.arc(
      x + w / 2,
      y - KNOB_OFFSET_PX * unit,
      KNOB_RADIUS_PX * unit + grow,
      0,
      2 * Math.PI,
    );
    ctx.fill();
  };

  const casing = style.casing ?? CASING;
  if (casing !== "transparent") {
    pass(rim, casing);
  }
  pass(0, style.color ?? MARK);

  ctx.restore();
}

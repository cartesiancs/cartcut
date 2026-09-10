/**
 * The selection outline for a **clip**.
 *
 * It used to carry a `dashed` option, and a pivot dot under it, for the one
 * caller that passed a group. Groups are drawn by
 * `features/renderer/nullGizmo.ts` now — from the same geometry their hit test
 * uses, which this function cannot offer: its handles are sized in *world*
 * pixels while every hit test sizes them in screen pixels divided by the world
 * scale. That mismatch is why a clip's grips shrink as you zoom out, and it is
 * the reason a null, whose handles are its entire visible existence, does not
 * share this path.
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
 * So: `RIM` world pixels of `CASING` around everything, drawn as a first pass
 * under the whole mark rather than per shape, which keeps the two passes from
 * cutting into each other where the box stroke meets a grip.
 */
export type ControlOutlineStyle = {
  color?: string;
  /** The contrast pass under `color`. Pass `"transparent"` to suppress it. */
  casing?: string;
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
 * How far the casing stands out past the mark, in the same world pixels
 * everything else here is measured in. Half the line width, so the rim reads at
 * the zoom the outline was drawn for without thickening the outline itself.
 */
const RIM = 1.5;

const LINE_WIDTH = 3;
/** Half-size of a corner grip, and the unit the edge bars are derived from. */
const PADDING = 10;
/** The rotation knob: how far above the box, and how big. */
const KNOB_OFFSET = 50;
const KNOB_RADIUS = 15;

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

  const padding = PADDING;

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
   * The casing is this same drawing with `grow = RIM`, which is what keeps the
   * two in step: a mark added below gets its rim for free, and a bar the cap
   * above suppresses is suppressed in both passes — the `bw > 0` test reads the
   * *ungrown* size so a casing can never appear under a mark that is not there.
   */
  const pass = (grow: number, paint: string) => {
    ctx.strokeStyle = paint;
    ctx.fillStyle = paint;

    ctx.lineWidth = LINE_WIDTH + grow * 2;
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
    ctx.arc(x + w / 2, y - KNOB_OFFSET, KNOB_RADIUS + grow, 0, 2 * Math.PI);
    ctx.fill();
  };

  const casing = style.casing ?? CASING;
  if (casing !== "transparent") {
    pass(RIM, casing);
  }
  pass(0, style.color ?? MARK);

  ctx.restore();
}

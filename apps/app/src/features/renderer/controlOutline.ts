export type ControlOutlineStyle = {
  /**
   * Draw the box as a dashed line rather than a solid one.
   *
   * For a group, whose `width`/`height` are an invisible frame rather than
   * anything that gets painted. A solid box would claim there are pixels there;
   * a dashed one says "this is a boundary you are holding", which is the same
   * language every design tool uses for a frame or guide.
   */
  dashed?: boolean;
  color?: string;
};

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

  const padding = 10;
  const color = style.color ?? "#ffffff";
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  if (style.dashed) {
    // Scaled off the box so the dashes stay legible on a frame of any size.
    const dash = Math.max(6, Math.min(w, h) / 24);
    ctx.setLineDash([dash, dash]);
  }
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  ctx.fillStyle = color;

  ctx.beginPath();
  ctx.rect(x - padding, y - padding, padding * 2, padding * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.rect(x + w - padding, y - padding, padding * 2, padding * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.rect(x + w - padding, y + h - padding, padding * 2, padding * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.rect(x - padding, y + h - padding, padding * 2, padding * 2);
  ctx.fill();

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

  const drawBar = (cx: number, cy: number, bw: number, bh: number) => {
    if (!(bw > 0) || !(bh > 0)) {
      return;
    }
    ctx.beginPath();
    ctx.rect(cx - bw / 2, cy - bh / 2, bw, bh);
    ctx.fill();
  };

  const hBar = barLength(w);
  const vBar = barLength(h);
  drawBar(x + w / 2, y, hBar, barThickness);
  drawBar(x + w / 2, y + h, hBar, barThickness);
  drawBar(x, y + h / 2, barThickness, vBar);
  drawBar(x + w, y + h / 2, barThickness, vBar);

  //draw control rotation

  ctx.beginPath();
  ctx.arc(x + w / 2, y - 50, 15, 0, 2 * Math.PI);
  ctx.fill();

  // The pivot everything on this box rotates and scales about. Only worth
  // marking when the box is a frame rather than a picture: for a group it is
  // the whole reason the frame is adjustable, and without a mark there is
  // nothing on screen to aim it with.
  if (style.dashed) {
    ctx.beginPath();
    ctx.arc(x + w / 2, y + h / 2, 6, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + w / 2, y + h / 2, 2, 0, 2 * Math.PI);
    ctx.fill();
  }

  ctx.restore();
}

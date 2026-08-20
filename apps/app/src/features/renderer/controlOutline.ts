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

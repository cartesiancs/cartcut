uniform float cells;
uniform float stagger;

// Every cell scales through zero on its own clock and comes back showing the
// other clip — a card turning edge-on. Checkerboard swaps cells whole; this
// one animates the swap inside each cell, which is a different mechanism
// wearing a similar grid.
vec4 transition(vec2 uv) {
  vec2 grid = vec2(cells * ratio, cells);
  vec2 cell = floor(uv * grid);
  vec2 inCell = fract(uv * grid);

  // A diagonal sweep so the flips travel across the frame instead of firing at
  // random.
  float wave = (cell.x + cell.y) / max(grid.x + grid.y, 1.0);
  float span = 1.0 - stagger;
  float local = clamp((progress - wave * stagger) / max(span, 0.0001), 0.0, 1.0);

  // Squash to nothing at the halfway point, then back out.
  float squash = abs(local * 2.0 - 1.0);
  vec2 p = cell / grid + vec2(0.5, (inCell.y - 0.5) / max(squash, 0.0001) + 0.5) / grid;
  p.x = cell.x / grid.x + inCell.x / grid.x;

  bool showTo = local > 0.5;
  vec2 sampleUv = clamp(p, 0.0, 1.0);
  return showTo ? getToColor(sampleUv) : getFromColor(sampleUv);
}

uniform float cells;
uniform float stagger;

// Squares flip over in two interleaved waves, so the frame changes as a board
// rather than as a front. `stagger` is the delay between the two colours — at
// zero every cell turns together and it degenerates into a hard cut.
vec4 transition(vec2 uv) {
  vec2 grid = vec2(cells * ratio, cells);
  vec2 cell = floor(uv * grid);
  float odd = mod(cell.x + cell.y, 2.0);

  // Each colour gets its own window inside the transition.
  float span = 1.0 - stagger;
  float start = odd * stagger;
  float local = clamp((progress - start) / max(span, 0.0001), 0.0, 1.0);

  return mix(getFromColor(uv), getToColor(uv), step(0.5, local));
}

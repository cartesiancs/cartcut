uniform float blocks;

// Both clips dissolve into blocks, meet at their coarsest, and resolve again.
// The block size is what carries the transition; the mix underneath is just a
// crossfade, and on its own would look like nothing at all.
vec4 transition(vec2 uv) {
  float coarseness = (0.5 - abs(progress - 0.5)) * 2.0;
  // 1 block would collapse the whole frame to one colour, so the floor keeps
  // some structure even at the midpoint.
  float grid = mix(600.0, blocks, coarseness);

  vec2 cell = vec2(grid * ratio, grid);
  vec2 p = (floor(uv * cell) + 0.5) / cell;

  return mix(getFromColor(p), getToColor(p), progress);
}

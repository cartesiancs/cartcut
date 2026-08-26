uniform float vertical;
uniform float shade;

varying float vFacing;

// One sheet turning over, `from` printed on the front and `to` on the back.
// Unlike Cube Rotate there is no second surface and nothing to occlude — the
// swap happens the instant the plane passes edge-on.
vec4 transition(vec2 uv) {
  if (progress < 0.5) {
    return getFromColor(uv) * mix(1.0, vFacing, shade);
  }
  // Seen from behind, so the back face is mirrored across the turning axis. Not
  // undoing that would print the incoming clip backwards.
  vec2 flipped = vertical > 0.5
    ? vec2(uv.x, 1.0 - uv.y)
    : vec2(1.0 - uv.x, uv.y);
  return getToColor(flipped) * mix(1.0, vFacing, shade);
}

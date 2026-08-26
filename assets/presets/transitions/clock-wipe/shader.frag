uniform float startAngle;
uniform float softness;

const float TAU = 6.28318530718;

// A hand sweeping round the frame. The wipe coordinate is the angle rather
// than a distance, which is the only thing separating this from an iris.
vec4 transition(vec2 uv) {
  vec2 c = uv - 0.5;
  // Undo the frame's aspect so the hand sweeps at an even rate instead of
  // racing through the short axis.
  c.x *= ratio;
  float angle = atan(c.y, c.x) - startAngle;
  float t = fract(angle / TAU + 1.0);
  float edge = progress * (1.0 + 2.0 * softness) - softness;
  float m = smoothstep(edge - softness, edge + softness, t);
  return mix(getToColor(uv), getFromColor(uv), m);
}

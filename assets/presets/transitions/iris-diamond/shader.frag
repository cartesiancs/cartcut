uniform vec2 centre;
uniform float softness;

// The same opening shape under a different metric: Manhattan distance draws a
// diamond where Euclidean draws a circle. One line apart, and the only line
// that matters.
vec4 transition(vec2 uv) {
  vec2 d = uv - centre;
  d.x *= ratio;
  vec2 far = vec2(
    max(centre.x, 1.0 - centre.x) * ratio,
    max(centre.y, 1.0 - centre.y)
  );
  float t = (abs(d.x) + abs(d.y)) / max(far.x + far.y, 0.0001);
  float edge = progress * (1.0 + 2.0 * softness) - softness;
  float m = smoothstep(edge - softness, edge + softness, t);
  return mix(getToColor(uv), getFromColor(uv), m);
}

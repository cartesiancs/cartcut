uniform vec2 centre;
uniform float softness;

// A circle opening out of a point. Normalised against the distance to the
// furthest corner *from that point*, so an off-centre iris still finishes
// exactly at progress 1 instead of leaving the far corner uncovered.
vec4 transition(vec2 uv) {
  vec2 d = uv - centre;
  d.x *= ratio;
  vec2 far = vec2(
    max(centre.x, 1.0 - centre.x) * ratio,
    max(centre.y, 1.0 - centre.y)
  );
  float t = length(d) / max(length(far), 0.0001);
  float edge = progress * (1.0 + 2.0 * softness) - softness;
  float m = smoothstep(edge - softness, edge + softness, t);
  return mix(getToColor(uv), getFromColor(uv), m);
}

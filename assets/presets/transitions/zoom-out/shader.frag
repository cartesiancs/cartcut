uniform float amount;

// The mirror image: the incoming clip falls back from oversize into place
// while the outgoing one holds still. Scaling `to` rather than `from` is the
// whole difference, and it reverses which clip the eye follows.
vec4 transition(vec2 uv) {
  float scale = 1.0 + amount * (1.0 - progress);
  vec2 toUv = (uv - 0.5) / scale + 0.5;
  return mix(getFromColor(uv), getToColor(toUv), progress);
}

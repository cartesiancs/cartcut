uniform float levels;
uniform float perceptual;

// Continuous tone collapsed onto a few flat steps. `perceptual` quantises in
// gamma space rather than linearly, which puts the steps where the eye can see
// them instead of crowding them all in the highlights.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);
  float n = max(levels, 2.0);

  vec3 c;
  if (perceptual > 0.5) {
    vec3 g = pow(base.rgb, vec3(1.0 / 2.2));
    c = pow(floor(g * n) / (n - 1.0), vec3(2.2));
  } else {
    c = floor(base.rgb * n) / (n - 1.0);
  }

  return vec4(mix(base.rgb, clamp(c, 0.0, 1.0), intensity), base.a);
}

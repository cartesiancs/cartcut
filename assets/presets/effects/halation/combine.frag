uniform float amount;

// Screen rather than add. Halation lives in the negative, under the image, so
// it lifts what is dark around a highlight without driving the highlight itself
// any further — the visible difference between this and Bloom.
vec4 effect(vec2 uv) {
  vec3 base = getOriginalColor(uv).rgb;
  vec3 halo = clamp(getSourceColor(uv).rgb * amount, 0.0, 1.0);

  vec3 c = 1.0 - (1.0 - base) * (1.0 - halo);
  return vec4(mix(base, clamp(c, 0.0, 1.0), intensity), 1.0);
}

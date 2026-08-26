uniform float cutoff;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Step one: keep only what is bright enough to bloom. Everything below the
// cutoff goes to black, so the blur that follows spreads light rather than
// spreading the whole picture.
vec4 effect(vec2 uv) {
  vec3 c = getSourceColor(uv).rgb;
  float l = dot(c, LUMA);
  // Soft knee, so a highlight drifting past the threshold fades in instead of
  // popping on.
  return vec4(c * smoothstep(cutoff, cutoff + 0.15, l), 1.0);
}

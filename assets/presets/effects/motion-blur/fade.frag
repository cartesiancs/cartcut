// Only to put the smeared result back against the untouched frame. The smear
// pass has to stay unfaded, or `intensity` would be applied to a partial
// result and again here.
vec4 effect(vec2 uv) {
  vec3 base = getOriginalColor(uv).rgb;
  return vec4(mix(base, getSourceColor(uv).rgb, intensity), 1.0);
}

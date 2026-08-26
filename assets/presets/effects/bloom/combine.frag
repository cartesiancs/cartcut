uniform float amount;

// Step four: the blurred highlights added back over the untouched frame.
// `original` is what makes this possible — `source` by now is three passes deep
// and no longer holds the picture.
vec4 effect(vec2 uv) {
  vec3 base = getOriginalColor(uv).rgb;
  vec3 glow = getSourceColor(uv).rgb;

  // Added, not mixed: bloom is light arriving on top, so it can push a highlight
  // past white rather than washing the midtones towards it.
  vec3 c = base + glow * amount;
  return vec4(mix(base, clamp(c, 0.0, 1.0), intensity), 1.0);
}

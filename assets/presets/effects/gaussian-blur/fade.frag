// The blur itself is done; this only puts it back against the untouched frame
// so `intensity` fades the effect as a whole.
//
// It is a pass of its own rather than folded into the last blur because only
// `passes` entries carry `constants`, and the final `source` would have no
// `dir` or `stage` to work with: both would read zero, every tap would land on
// the same texel, and the last stage of the blur would quietly go missing.
vec4 effect(vec2 uv) {
  vec3 base = getOriginalColor(uv).rgb;
  return vec4(mix(base, getSourceColor(uv).rgb, intensity), 1.0);
}

// The blur itself is done; this only puts it back against the untouched frame
// so `intensity` fades the effect as a whole.
//
// It is a third pass rather than folding the fade into the vertical blur
// because only `passes` entries carry `constants`, and the final `source` would
// have no `dir` to work with — it would read zero, take one tap, and quietly
// undo the second half of the blur.
vec4 effect(vec2 uv) {
  vec3 base = getOriginalColor(uv).rgb;
  return vec4(mix(base, getSourceColor(uv).rgb, intensity), 1.0);
}

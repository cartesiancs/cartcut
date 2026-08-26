uniform vec3 shadowTone;
uniform vec3 highlightTone;
uniform float balance;
uniform float amount;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Cool shadows, warm highlights — the split-tone look, where the two ends of
// the range are tinted in opposite directions and the middle is left alone.
// Unlike Duotone the picture keeps its own colour; only the ends are pushed.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);
  float l = dot(base.rgb, LUMA);

  // `balance` slides where the handover happens, so a dark shot can still be
  // split somewhere other than at its own midpoint.
  float high = smoothstep(balance - 0.35, balance + 0.35, l);
  vec3 tone = mix(shadowTone, highlightTone, high);

  // Soft light: tint without flattening, so texture in both ends survives.
  vec3 c = mix(base.rgb, base.rgb * (1.0 - tone) + tone * l * 2.0, amount);

  return vec4(mix(base.rgb, clamp(c, 0.0, 1.0), intensity), base.a);
}

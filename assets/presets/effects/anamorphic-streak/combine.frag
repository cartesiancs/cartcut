uniform float amount;
uniform vec3 tint;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec4 effect(vec2 uv) {
  vec3 base = getOriginalColor(uv).rgb;
  vec3 streak = getSourceColor(uv).rgb;

  // Tinted by its own brightness, so the streak takes the lens's colour cast
  // without painting flat blue over the highlight that made it.
  vec3 c = base + tint * dot(streak, LUMA) * amount;
  return vec4(mix(base, clamp(c, 0.0, 1.0), intensity), 1.0);
}

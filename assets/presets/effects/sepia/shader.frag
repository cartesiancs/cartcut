uniform float amount;

// The photographic sepia matrix, not a brown tint over grey. Each output
// channel takes its own mix of all three inputs, which is why a red and a green
// of the same brightness come out at different values — the thing a Duotone
// ramp cannot reproduce.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  vec3 c = vec3(
    dot(base.rgb, vec3(0.393, 0.769, 0.189)),
    dot(base.rgb, vec3(0.349, 0.686, 0.168)),
    dot(base.rgb, vec3(0.272, 0.534, 0.131))
  );

  c = mix(base.rgb, c, amount);
  return vec4(mix(base.rgb, clamp(c, 0.0, 1.0), intensity), base.a);
}

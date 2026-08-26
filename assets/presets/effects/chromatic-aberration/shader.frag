uniform float amount;
uniform float radial;
uniform float angle;

// A lens that does not bring all three wavelengths to the same focus. Radial is
// what a real lens does — nothing at the centre, worst at the corners — and the
// fixed-angle mode is the stylised version, which is why both are here rather
// than as two presets.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  vec2 offset;
  if (radial > 0.5) {
    vec2 d = uv - 0.5;
    // Squared falloff, so the middle of the frame stays clean.
    offset = d * dot(d, d) * 4.0 * amount * 8.0;
  } else {
    offset = vec2(cos(angle), sin(angle)) * amount;
  }

  vec3 c = vec3(
    getSourceColor(clamp(uv + offset, 0.0, 1.0)).r,
    base.g,
    getSourceColor(clamp(uv - offset, 0.0, 1.0)).b
  );

  return vec4(mix(base.rgb, c, intensity), base.a);
}

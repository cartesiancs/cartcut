uniform float temperature;
uniform float tint;

// White balance, the two axes a camera actually has: blue-to-amber, and the
// green-to-magenta correction that fluorescent light needs. Everything else a
// grade does lives in its own preset — this one only moves the white point.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);
  vec3 c = base.rgb;

  // Warm lifts red and drops blue; cool is the same number negated.
  c.r += temperature * 0.14;
  c.b -= temperature * 0.14;

  // Magenta is red and blue together against green, which is why this is not
  // simply a third channel offset.
  c.g -= tint * 0.10;
  c.r += tint * 0.05;
  c.b += tint * 0.05;

  return vec4(mix(base.rgb, clamp(c, 0.0, 1.0), intensity), base.a);
}

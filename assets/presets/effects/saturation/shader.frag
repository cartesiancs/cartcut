uniform float saturation;
uniform float vibrance;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Two knobs that are often confused. Saturation scales every pixel's distance
// from grey equally; vibrance weights that by how grey the pixel already is, so
// it lifts a washed-out sky without turning skin orange.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);
  float grey = dot(base.rgb, LUMA);

  vec3 c = mix(vec3(grey), base.rgb, saturation);

  // How far this pixel already is from grey, 0..1.
  float current = clamp(
    (max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b))),
    0.0,
    1.0
  );
  c = mix(vec3(grey), c, 1.0 + vibrance * (1.0 - current));

  return vec4(mix(base.rgb, clamp(c, 0.0, 1.0), intensity), base.a);
}

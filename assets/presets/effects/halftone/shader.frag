uniform float dots;
uniform float angle;
uniform float keepColour;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// A printer's screen: tone carried by dot *size* on a fixed grid, which is what
// separates it from Pixelate — that averages a block and keeps its value, this
// throws the value away and keeps only how much ink to lay down.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  float aspect = resolution.x / max(resolution.y, 1.0);
  vec2 p = vec2(uv.x * aspect, uv.y);

  // Rotated, because an unrotated screen moires against every horizontal in
  // the picture. Forty-five degrees is the printer's default for the same
  // reason.
  float c = cos(angle);
  float s = sin(angle);
  vec2 rotated = vec2(p.x * c - p.y * s, p.x * s + p.y * c);

  vec2 cellUv = fract(rotated * dots) - 0.5;
  float toCentre = length(cellUv) * 2.0;

  float value = dot(base.rgb, LUMA);
  // Ink area grows as the tone darkens; sqrt because area, not radius, is what
  // the eye integrates.
  float radius = sqrt(1.0 - value) * 1.15;
  float ink = smoothstep(radius + 0.08, radius - 0.08, toCentre);

  vec3 out3 = keepColour > 0.5
    ? mix(vec3(1.0), base.rgb, ink)
    : vec3(1.0 - ink);

  return vec4(mix(base.rgb, clamp(out3, 0.0, 1.0), intensity), base.a);
}

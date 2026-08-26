uniform float amount;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// The lab process of skipping the bleach, so the silver stays in the print: a
// desaturated image laid back over the colour one in hard light. Contrast goes
// up hard while saturation drops — a combination neither Saturation nor
// Exposure & Contrast reaches, because it is not a curve, it is a composite.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);
  vec3 grey = vec3(dot(base.rgb, LUMA));

  // Hard light of the grey layer over the colour one.
  vec3 blended = mix(
    2.0 * base.rgb * grey,
    1.0 - 2.0 * (1.0 - base.rgb) * (1.0 - grey),
    step(0.5, grey)
  );

  vec3 c = mix(base.rgb, blended, amount);
  return vec4(mix(base.rgb, clamp(c, 0.0, 1.0), intensity), base.a);
}

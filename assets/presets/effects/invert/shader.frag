uniform float mode;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// A negative. The three modes are genuinely different pictures: inverting all
// three channels flips brightness and hue together, inverting luminance alone
// keeps colours where they were, and inverting hue alone keeps the exposure.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);
  vec3 c;

  if (mode < 0.5) {
    c = 1.0 - base.rgb;
  } else if (mode < 1.5) {
    float l = dot(base.rgb, LUMA);
    // Move every channel by the same amount, so the chroma difference survives.
    c = base.rgb + ((1.0 - l) - l);
  } else {
    float l = dot(base.rgb, LUMA);
    // Reflect the colour through its own grey, leaving that grey in place.
    c = 2.0 * vec3(l) - base.rgb;
  }

  return vec4(mix(base.rgb, clamp(c, 0.0, 1.0), intensity), base.a);
}

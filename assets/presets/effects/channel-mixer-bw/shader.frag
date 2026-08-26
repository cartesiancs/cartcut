uniform float redWeight;
uniform float greenWeight;
uniform float blueWeight;

// Black and white with the channel weights exposed, which is what a coloured
// lens filter did on film: wind the blue down and a sky goes dramatic without
// touching anything else. A plain desaturate cannot do that, and neither can
// Saturation at zero — this is why it is its own preset.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  float grey =
    base.r * redWeight + base.g * greenWeight + base.b * blueWeight;

  return vec4(mix(base.rgb, clamp(vec3(grey), 0.0, 1.0), intensity), base.a);
}

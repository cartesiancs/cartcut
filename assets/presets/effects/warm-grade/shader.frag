uniform float temperature;
uniform float saturation;
uniform float lift;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);
  vec3 color = base.rgb;

  // Warm pushes red up and blue down; cool is the same value negated.
  color.r += temperature * 0.12;
  color.b -= temperature * 0.12;

  color = mix(vec3(dot(color, LUMA)), color, saturation);
  color += lift;

  // `intensity` is always available, whatever the preset declares, so every
  // effect can be faded without having to offer a parameter for it.
  return vec4(mix(base.rgb, clamp(color, 0.0, 1.0), intensity), base.a);
}

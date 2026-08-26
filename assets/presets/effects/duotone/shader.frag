uniform vec3 dark;
uniform vec3 light;
uniform float contrast;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// The whole picture remapped onto a two-colour ramp — the screen-printed poster
// look. Every original hue is discarded, which is exactly what separates this
// from Split Tone.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  float l = dot(base.rgb, LUMA);
  l = clamp((l - 0.5) * contrast + 0.5, 0.0, 1.0);

  vec3 c = mix(dark, light, l);
  return vec4(mix(base.rgb, c, intensity), base.a);
}

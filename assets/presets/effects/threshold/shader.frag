uniform float level;
uniform float softness;
uniform vec3 darkColor;
uniform vec3 lightColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Two tones and one cut between them. Posterize at two levels still steps in
// each channel separately; this decides once, on luminance, which is what gives
// a clean stencil rather than a colour-fringed one.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);
  float l = dot(base.rgb, LUMA);

  float m = smoothstep(level - softness, level + softness, l);
  vec3 c = mix(darkColor, lightColor, m);

  return vec4(mix(base.rgb, c, intensity), base.a);
}

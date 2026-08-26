uniform float cutoff;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec4 effect(vec2 uv) {
  vec3 c = getSourceColor(uv).rgb;
  float l = dot(c, LUMA);
  return vec4(c * smoothstep(cutoff, cutoff + 0.1, l), 1.0);
}

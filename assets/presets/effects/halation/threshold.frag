uniform float cutoff;
uniform vec3 tint;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Halation is light passing through the emulsion, bouncing off the backing and
// re-exposing the film from behind — and the backing absorbs the short
// wavelengths, which is why the halo is red. So this pass keeps the bright
// areas *and* tints them, where Bloom's keeps them neutral.
vec4 effect(vec2 uv) {
  vec3 c = getSourceColor(uv).rgb;
  float l = dot(c, LUMA);
  return vec4(tint * l * smoothstep(cutoff, cutoff + 0.2, l), 1.0);
}

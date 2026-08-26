uniform float gamma;

// A dissolve done where light actually adds, rather than in the gamma-encoded
// values a texture happens to store. Decoding first is what stops the midpoint
// sagging into mud — the difference an optical printer gets for free and a
// naive `mix` does not.
vec4 transition(vec2 uv) {
  vec3 a = pow(getFromColor(uv).rgb, vec3(gamma));
  vec3 b = pow(getToColor(uv).rgb, vec3(gamma));
  vec3 blended = mix(a, b, progress);
  return vec4(pow(blended, vec3(1.0 / gamma)), 1.0);
}

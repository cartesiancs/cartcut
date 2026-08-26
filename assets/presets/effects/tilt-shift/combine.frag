uniform float focus;
uniform float band;
uniform float falloff;
uniform float angle;

// A shallow depth of field faked with a plane of focus, which is what a tilted
// lens gives and what makes a wide shot read as a model.
//
// The difference from Gaussian Blur is entirely in this pass: there the blurred
// result replaces the frame outright, here the two are chosen between per
// pixel. Which is why it needs `original` alongside the chain's output.
vec4 effect(vec2 uv) {
  vec3 sharp = getOriginalColor(uv).rgb;
  vec3 blurred = getSourceColor(uv).rgb;

  // Distance from the focus line, measured perpendicular to it, so the band can
  // be tilted rather than only horizontal.
  vec2 normal = vec2(-sin(angle), cos(angle));
  float across = dot(uv - vec2(0.5, focus), normal);

  vec3 c = mix(sharp, blurred, smoothstep(band, band + falloff, abs(across)));
  return vec4(mix(sharp, clamp(c, 0.0, 1.0), intensity), 1.0);
}

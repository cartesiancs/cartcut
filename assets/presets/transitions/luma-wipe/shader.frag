// The preset ships its own mask, bound by the host from `render.textures`.
// Host-bound samplers are declared by the wrapper, not here — unlike
// parameters, which the preset must declare itself.
uniform float softness;
uniform float invertMask;

vec4 transition(vec2 uv) {
  float luma = texture2D(lumaMask, uv).r;
  if (invertMask > 0.5) {
    luma = 1.0 - luma;
  }

  // The threshold sweeps past both ends by `softness` so the wipe fully
  // completes rather than stalling with a soft fringe at progress 0 and 1.
  float threshold = progress * (1.0 + 2.0 * softness) - softness;
  float reveal = smoothstep(threshold - softness, threshold + softness, luma);
  return mix(getToColor(uv), getFromColor(uv), reveal);
}

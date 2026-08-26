uniform float amount;
uniform float speed;
uniform vec3 tint;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(269.5, 183.3))) * 43758.5453123);
}

// Untuned-television static, laid over the picture rather than mixed into it.
// Film Grain modulates what is already there and dies in the extremes; this is
// an independent signal at full strength everywhere, which is why it is a
// separate preset and not a setting.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  // One sample per output pixel — static has no grain size, it is the raster.
  vec2 cell = floor(uv * resolution);
  float seed = floor(time * max(speed, 0.001));
  float n = hash(cell + seed);

  vec3 c = mix(base.rgb, tint * n, amount);
  return vec4(mix(base.rgb, clamp(c, 0.0, 1.0), intensity), base.a);
}

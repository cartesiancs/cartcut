uniform float amount;
uniform float grainSize;
uniform float rate;
uniform float monochrome;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Silver halide, which is a different grain on every frame. Without the time
// seed this was a fixed pattern burnt into the shot — a stain rather than
// grain, and the one thing that reads as obviously wrong at a glance.
//
// `rate` is how often the pattern is re-drawn. Real film re-rolls every frame;
// stepping it slower is the stylised look, and it is a parameter because both
// are wanted.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  // Quantise to grain-sized cells in pixel space, so the grain does not resize
  // with the preview's zoom or differ between preview and export.
  vec2 cell = floor(uv * resolution / max(grainSize, 0.001));
  // `time` is already snapped to the frame grid, so the same frame seeds the
  // same pattern in the preview and in the render. See `fx/effectTime.ts`.
  float seed = floor(time * max(rate, 1.0));

  vec3 noise;
  if (monochrome > 0.5) {
    noise = vec3(hash(cell + seed) - 0.5);
  } else {
    noise = vec3(
      hash(cell + seed) - 0.5,
      hash(cell + seed + 17.0) - 0.5,
      hash(cell + seed + 43.0) - 0.5
    );
  }

  // Grain lives in the midtones: film has none in clipped white or solid black.
  float l = dot(base.rgb, vec3(0.2126, 0.7152, 0.0722));
  float weight = 1.0 - abs(l * 2.0 - 1.0);

  vec3 graded = base.rgb + noise * amount * 2.0 * weight;
  return vec4(mix(base.rgb, clamp(graded, 0.0, 1.0), intensity), base.a);
}

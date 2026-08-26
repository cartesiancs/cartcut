uniform float amount;
uniform float grainSize;
uniform float monochrome;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  // Quantise to grain-sized cells in pixel space, so the grain does not
  // resize with the preview's zoom or differ between preview and export.
  vec2 cell = floor(uv * resolution / max(grainSize, 0.001));

  vec3 noise;
  if (monochrome > 0.5) {
    noise = vec3(hash(cell) - 0.5);
  } else {
    noise = vec3(
      hash(cell) - 0.5,
      hash(cell + 17.0) - 0.5,
      hash(cell + 43.0) - 0.5
    );
  }

  vec3 graded = base.rgb + noise * amount * 2.0;
  return vec4(mix(base.rgb, clamp(graded, 0.0, 1.0), intensity), base.a);
}

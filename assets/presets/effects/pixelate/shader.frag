uniform float blockSize;
uniform float average;

// Blocks, sized in pixels so the mosaic does not change with the preview's
// zoom. `average` decides whether a block takes its centre's colour — cheap,
// and what a nearest-neighbour downscale gives — or the mean of a few samples,
// which is what it should be and what stops fine detail flickering as the
// picture moves under it.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  vec2 block = max(vec2(blockSize), vec2(1.0)) / resolution;
  vec2 corner = floor(uv / block) * block;

  vec3 c;
  if (average > 0.5) {
    c = vec3(0.0);
    for (int y = 0; y < 3; y++) {
      for (int x = 0; x < 3; x++) {
        vec2 at = corner + block * (vec2(float(x), float(y)) + 0.5) / 3.0;
        c += getSourceColor(clamp(at, 0.0, 1.0)).rgb;
      }
    }
    c /= 9.0;
  } else {
    c = getSourceColor(clamp(corner + block * 0.5, 0.0, 1.0)).rgb;
  }

  return vec4(mix(base.rgb, c, intensity), base.a);
}

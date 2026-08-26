uniform float dust;
uniform float scratches;
uniform float rate;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Print damage: specks that sit still for a frame and vertical hairs that jump
// about. Both are sparse — the difference from noise is that most frames and
// most of each frame are untouched, which is what makes the hits read as
// damage rather than as texture.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);
  vec3 c = base.rgb;

  float seed = floor(time * max(rate, 1.0));

  // Dust: a coarse lattice, of which only the few cells above the cut fire.
  vec2 cell = floor(uv * resolution / 3.0);
  float speck = hash(cell + seed * 7.0);
  float threshold = 1.0 - dust * 0.02;
  if (speck > threshold) {
    // Both bright specks and dark ones, as dirt on the negative and on the
    // print give opposite signs.
    float polarity = step(0.5, hash(cell + seed * 13.0));
    c = mix(c, vec3(polarity), 0.85);
  }

  // Scratches: a handful of columns, each persisting for the frame.
  float column = floor(uv.x * resolution.x / 2.0);
  float pick = hash(vec2(column, seed));
  if (pick > 1.0 - scratches * 0.01) {
    // Fades out along its length rather than running the full height.
    float extent = hash(vec2(column, seed + 5.0));
    float fade = smoothstep(0.0, 0.35, abs(uv.y - extent));
    c = mix(vec3(1.0), c, clamp(fade + 0.25, 0.0, 1.0));
  }

  return vec4(mix(base.rgb, clamp(c, 0.0, 1.0), intensity), base.a);
}

uniform float lines;
uniform float depth;
uniform float roll;

// A CRT's raster: alternating bright and dark rows, optionally drifting the way
// an out-of-sync monitor rolls. Regular and geometric, where Dust & Scratches
// is sparse and random — the two are not variations of one thing.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  float phase = (uv.y + time * roll * 0.1) * lines * 3.14159265;
  // Squared so the dark rows are narrower than the light ones, as a beam's
  // profile makes them.
  float line = pow(sin(phase) * 0.5 + 0.5, 2.0);

  vec3 c = base.rgb * mix(1.0, line, depth);
  return vec4(mix(base.rgb, clamp(c, 0.0, 1.0), intensity), base.a);
}

uniform float amount;
uniform vec2 centre;
uniform float mode;

// Smear along the direction away from a centre, or around it. Not separable —
// every pixel's smear axis is different — so it stays a single pass and pays
// for its samples directly, unlike Gaussian Blur.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  vec2 d = uv - centre;
  // Perpendicular for spin, along the ray for zoom.
  vec2 axis = mode < 0.5 ? d : vec2(-d.y, d.x);

  vec3 c = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    float t = float(i) / 11.0 - 0.5;
    c += getSourceColor(clamp(uv + axis * t * amount, 0.0, 1.0)).rgb;
  }
  c /= 12.0;

  return vec4(mix(base.rgb, c, intensity), base.a);
}

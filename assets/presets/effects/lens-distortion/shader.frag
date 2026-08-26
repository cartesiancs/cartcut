uniform float k1;
uniform float k2;
uniform float zoom;

// Barrel and pincushion, as the two-term radial polynomial a lens profile is
// actually written in. Positive bulges outward like a wide angle; negative
// pinches like a long one. `zoom` is here because correcting distortion always
// exposes the corners, and cropping back is part of the same operation.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  float aspect = resolution.x / max(resolution.y, 1.0);
  vec2 d = vec2((uv.x - 0.5) * aspect, uv.y - 0.5) / max(zoom, 0.001);

  float r2 = dot(d, d);
  float scale = 1.0 + k1 * r2 + k2 * r2 * r2;
  vec2 warped = d * scale;

  vec2 at = vec2(warped.x / aspect + 0.5, warped.y + 0.5);
  if (at.x < 0.0 || at.x > 1.0 || at.y < 0.0 || at.y > 1.0) {
    // Outside the frame there is no picture to fetch. Black is honest; clamping
    // would smear the border pixel into a long streak.
    return vec4(mix(base.rgb, vec3(0.0), intensity), base.a);
  }

  vec3 c = getSourceColor(at).rgb;
  return vec4(mix(base.rgb, c, intensity), base.a);
}

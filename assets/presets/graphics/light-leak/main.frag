// Soft warm light drifting across the frame, as from a leak in a camera body.
// Three gaussian blobs wander on slow orbits; the third breathes.
//
// The output is light, not paint: the colour is the blobs' hue at full
// brightness and the alpha is how much light there is, so the clip lays over
// footage as a glow, and over a Screen or Add blend as a real leak.

uniform vec3 warm;
uniform vec3 hot;
uniform float speed;
uniform float intensity;

float blob(vec2 p, vec2 c, float r) {
  vec2 d = p - c;
  return exp(-dot(d, d) / (r * r));
}

vec4 graphic(vec2 uv) {
  float t = time * speed;
  float aspect = resolution.x / max(resolution.y, 1.0);
  vec2 p = vec2(uv.x * aspect, uv.y);

  vec2 c1 = vec2(aspect * (0.15 + 0.25 * sin(t * 0.21)), 0.7 + 0.25 * sin(t * 0.17 + 1.3));
  vec2 c2 = vec2(aspect * (0.9 + 0.15 * cos(t * 0.19)), 0.3 + 0.3 * sin(t * 0.13 + 0.4));
  vec2 c3 = vec2(aspect * (0.5 + 0.4 * sin(t * 0.11 + 2.1)), 1.05 + 0.1 * cos(t * 0.23));

  float b1 = blob(p, c1, 0.45);
  float b2 = blob(p, c2, 0.35);
  float b3 = blob(p, c3, 0.6) * (0.6 + 0.4 * sin(t * 0.5));

  vec3 light = warm * (b1 + 0.7 * b3) + hot * b2;
  float peak = max(max(light.r, light.g), light.b);
  float alpha = clamp(peak * intensity, 0.0, 1.0);
  vec3 hue = peak > 0.0001 ? clamp(light / peak, 0.0, 1.0) : warm;
  return vec4(hue, alpha);
}

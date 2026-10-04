// Four colours pinned to points that drift on slow, unrelated orbits, blended
// by inverse distance over a coordinate field bent by two sine waves. The
// orbit periods share no common factor, so the pattern does not visibly repeat.

uniform vec3 colorA;
uniform vec3 colorB;
uniform vec3 colorC;
uniform vec3 colorD;
uniform float speed;

float weightAt(vec2 p, vec2 c) {
  vec2 d = p - c;
  float r = dot(d, d);
  return 1.0 / (0.002 + r * r);
}

// A cheap hash for dither. An 8-bit export of a smooth gradient bands; a
// quarter of a level of noise breaks the bands up.
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec4 graphic(vec2 uv) {
  float t = time * speed;
  float aspect = resolution.x / max(resolution.y, 1.0);
  vec2 p = vec2(uv.x * aspect, uv.y);
  p += 0.08 * vec2(sin(p.y * 3.0 + t * 0.9), cos(p.x * 2.5 - t * 0.7));

  vec2 a = vec2(aspect * (0.2 + 0.12 * sin(t * 0.31)), 0.25 + 0.15 * cos(t * 0.27));
  vec2 b = vec2(aspect * (0.8 + 0.1 * cos(t * 0.23)), 0.2 + 0.12 * sin(t * 0.37 + 1.0));
  vec2 c = vec2(aspect * (0.75 + 0.12 * sin(t * 0.29 + 2.0)), 0.8 + 0.1 * cos(t * 0.33));
  vec2 d = vec2(aspect * (0.25 + 0.1 * cos(t * 0.35 + 3.0)), 0.78 + 0.14 * sin(t * 0.21));

  float wa = weightAt(p, a);
  float wb = weightAt(p, b);
  float wc = weightAt(p, c);
  float wd = weightAt(p, d);
  vec3 color = (colorA * wa + colorB * wb + colorC * wc + colorD * wd) / (wa + wb + wc + wd);

  color += (hash(uv * resolution) - 0.5) / 255.0;
  return vec4(clamp(color, 0.0, 1.0), 1.0);
}

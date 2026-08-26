uniform vec2 dir;
uniform float radius;

// Nine taps of a gaussian, on one axis. Run horizontally then vertically this
// is a full 2D blur for 18 samples instead of 81 — the reason a real blur needs
// more than one pass at all.
const float W0 = 0.2270270270;
const float W1 = 0.1945945946;
const float W2 = 0.1216216216;
const float W3 = 0.0540540541;
const float W4 = 0.0162162162;

// No `intensity` anywhere in here: it is applied once, by the pass that puts
// the result back against `original`. Fading on every step would apply it
// three times over.
vec4 effect(vec2 uv) {
  vec2 step = dir * max(radius, 0.0) / resolution;

  vec3 c = getSourceColor(uv).rgb * W0;
  c += getSourceColor(clamp(uv + step * 1.0, 0.0, 1.0)).rgb * W1;
  c += getSourceColor(clamp(uv - step * 1.0, 0.0, 1.0)).rgb * W1;
  c += getSourceColor(clamp(uv + step * 2.0, 0.0, 1.0)).rgb * W2;
  c += getSourceColor(clamp(uv - step * 2.0, 0.0, 1.0)).rgb * W2;
  c += getSourceColor(clamp(uv + step * 3.0, 0.0, 1.0)).rgb * W3;
  c += getSourceColor(clamp(uv - step * 3.0, 0.0, 1.0)).rgb * W3;
  c += getSourceColor(clamp(uv + step * 4.0, 0.0, 1.0)).rgb * W4;
  c += getSourceColor(clamp(uv - step * 4.0, 0.0, 1.0)).rgb * W4;

  return vec4(c, 1.0);
}

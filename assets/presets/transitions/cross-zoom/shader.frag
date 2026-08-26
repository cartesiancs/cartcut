uniform float strength;

const int SAMPLES = 12;

// A zoom blur that peaks at the cut and resolves at both ends — the smear a
// whip-zoom leaves. Accumulating along the scale axis is what makes it a blur
// rather than a scale: every sample is a slightly different magnification of
// the same dissolve.
vec4 transition(vec2 uv) {
  float peak = (0.5 - abs(progress - 0.5)) * 2.0;
  float reach = strength * peak;

  vec4 total = vec4(0.0);
  for (int i = 0; i < SAMPLES; i++) {
    float t = float(i) / float(SAMPLES - 1);
    float scale = 1.0 + reach * t;
    vec2 p = (uv - 0.5) / scale + 0.5;
    total += mix(getFromColor(p), getToColor(p), progress);
  }
  return total / float(SAMPLES);
}

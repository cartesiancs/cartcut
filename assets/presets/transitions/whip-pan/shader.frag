uniform float direction;
uniform float strength;

const int SAMPLES = 10;

// A camera thrown from one subject to the next. The clips push past each other
// as in Push, but every sample is offset along the travel axis, so the frame
// smears in the direction it is moving and clears as it settles.
vec4 transition(vec2 uv) {
  vec2 axis = direction < 0.5 ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  float peak = (0.5 - abs(progress - 0.5)) * 2.0;
  float smear = strength * peak;

  vec4 total = vec4(0.0);
  for (int i = 0; i < SAMPLES; i++) {
    float t = (float(i) / float(SAMPLES - 1) - 0.5) * smear;
    vec2 offset = axis * t;
    vec2 fromUv = uv + axis * progress + offset;
    vec2 toUv = uv + axis * (progress - 1.0) + offset;

    bool insideFrom =
      fromUv.x >= 0.0 && fromUv.x <= 1.0 &&
      fromUv.y >= 0.0 && fromUv.y <= 1.0;

    total += insideFrom ? getFromColor(fromUv) : getToColor(toUv);
  }
  return total / float(SAMPLES);
}

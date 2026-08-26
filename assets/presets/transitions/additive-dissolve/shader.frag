uniform float boost;

// Light adding to light, the way two projectors overlapping actually behave.
// A plain mix darkens through the middle because it averages; this keeps the
// energy and lets the midpoint bloom instead.
vec4 transition(vec2 uv) {
  vec3 a = getFromColor(uv).rgb;
  vec3 b = getToColor(uv).rgb;
  vec3 blended = a * (1.0 - progress) + b * progress;
  // Peaks at the halfway point and vanishes at both ends, so the transition
  // still resolves exactly to each clip.
  float peak = 1.0 - abs(progress * 2.0 - 1.0);
  vec3 lift = a * b * boost * peak;
  return vec4(clamp(blended + lift, 0.0, 1.0), 1.0);
}

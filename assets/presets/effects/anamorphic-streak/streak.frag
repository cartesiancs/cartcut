uniform float reach;
uniform float streakLength;
uniform float angle;

// A one-dimensional smear, which is what an anamorphic element gives: the
// cylindrical front squeezes horizontally, so a flare spreads along one axis
// only. A gaussian blur cannot make this shape at any radius.
//
// `reach` is the per-pass tap spacing, and comes from the manifest rather than
// from the user. Doubling the spacing on a second run rather than doubling the
// tap count is what makes a streak this long affordable.
vec4 effect(vec2 uv) {
  vec2 axis = vec2(cos(angle), sin(angle));
  vec2 step = axis * (streakLength * reach) / resolution / 8.0;

  vec3 c = vec3(0.0);
  float total = 0.0;
  for (int i = -8; i <= 8; i++) {
    float t = float(i);
    // Falls away along its length, or the streak ends in a hard stop.
    float w = exp(-abs(t) * 0.28);
    c += getSourceColor(clamp(uv + step * t, 0.0, 1.0)).rgb * w;
    total += w;
  }

  return vec4(c / total, 1.0);
}

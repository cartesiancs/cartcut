uniform vec3 lift;
uniform vec3 gamma;
uniform vec3 gain;

// The three-wheel grade, per channel. Lift shifts the black point, gain scales
// the white point, and gamma bends what lies between without moving either —
// which is why all three are needed and none substitutes for another.
//
// Each wheel is a colour whose neutral is mid grey, so #808080 across the board
// is the identity and a wheel nudged towards blue cools only its own range.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  // Re-centre each control on zero: 0.5 means "leave alone".
  vec3 l = (lift - 0.5) * 0.5;
  vec3 g = (gain - 0.5) * 2.0 + 1.0;
  // Inverted so that a brighter wheel brightens: a smaller exponent lifts.
  vec3 m = 1.0 / max(vec3(0.05), 1.0 + (0.5 - gamma) * 2.0);

  vec3 c = base.rgb + l;
  c = c * g;
  c = pow(max(c, vec3(0.0)), m);

  return vec4(mix(base.rgb, clamp(c, 0.0, 1.0), intensity), base.a);
}

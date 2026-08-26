uniform vec3 tint;
uniform float strength;

// A bulb going off over the cut. Distinct from Dip to Colour, which fades the
// frame *out* to a flat colour and back: this one leaves both clips at full
// brightness and adds light on top, so detail stays visible through the peak.
vec4 transition(vec2 uv) {
  vec4 base = mix(getFromColor(uv), getToColor(uv), progress);
  // Sharp attack, slower decay — a flash that ramps up symmetrically reads as a
  // fade, not as a strike.
  float peak = 1.0 - abs(progress - 0.5) * 2.0;
  float burst = pow(max(peak, 0.0), 1.6) * strength;
  return vec4(base.rgb + tint * burst, 1.0);
}

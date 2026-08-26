uniform float rate;
uniform float duty;
uniform vec3 offColor;

// A hard on/off gate. Flicker modulates brightness continuously; this replaces
// the frame outright for part of every cycle, which is a different thing to
// look at and a different thing to cut to music with.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  float phase = fract(time * max(rate, 0.001));
  // No smoothing at all — a strobe with a soft edge is a flicker.
  float on = step(phase, duty);

  vec3 c = mix(offColor, base.rgb, on);
  return vec4(mix(base.rgb, c, intensity), base.a);
}

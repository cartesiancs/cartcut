uniform float amount;
uniform float rate;
uniform float irregularity;

float hash(float n) {
  return fract(sin(n * 127.1) * 43758.5453123);
}

// An unsteady source — candle, faulty tube, projector lamp. The whole frame
// moves together, and `irregularity` blends between a clean sine and a random
// walk. At zero it is a steady pulse; at one it never repeats.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  float t = time * max(rate, 0.001);
  float smoothPulse = sin(t * 6.28318530718) * 0.5 + 0.5;
  // Interpolated between samples so the random component drifts rather than
  // stepping, which is what a real lamp does.
  float i = floor(t);
  float f = fract(t);
  f = f * f * (3.0 - 2.0 * f);
  float rough = mix(hash(i), hash(i + 1.0), f);

  float level = mix(smoothPulse, rough, irregularity);
  // Dims only: a lamp that flickers goes dark, it does not overexpose.
  float gain = 1.0 - amount * (1.0 - level);

  return vec4(mix(base.rgb, clamp(base.rgb * gain, 0.0, 1.0), intensity), base.a);
}

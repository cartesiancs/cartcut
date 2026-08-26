uniform float amount;
uniform float bands;
uniform float rate;
uniform float split;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Digital corruption on a running shot: whole bands jump sideways and the
// channels come apart, re-rolled on its own clock. Sparse in time — most
// frames are barely touched — which is what makes the hits land.
//
// The transition of the same name is a different animal: there the corruption
// is driven by `progress` across a cut and is guaranteed to resolve. This one
// has no cut and never resolves, so neither shader could serve for the other.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  float tick = floor(time * max(rate, 0.001));

  // Corruption comes in bursts, with a low baseline between them — not an
  // all-or-nothing gate. Returning the frame untouched on quiet ticks made the
  // effect look broken for most of its running time, and made its preview tile
  // indistinguishable from no effect at all.
  float burst = step(1.0 - amount * 0.55, hash(vec2(tick, 3.7)));
  float severity = mix(0.22, 1.0, burst);

  float band = floor(uv.y * bands);
  float pick = hash(vec2(band, tick));
  // Only some bands move, and fewer of them between bursts.
  float active = step(mix(0.82, 0.55, burst), pick);
  float shift =
    (hash(vec2(band, tick + 11.0)) - 0.5) * 0.18 * amount * active * severity;

  vec2 p = vec2(clamp(uv.x + shift, 0.0, 1.0), uv.y);
  float lag = shift * split;

  vec3 c = vec3(
    getSourceColor(vec2(clamp(p.x + lag, 0.0, 1.0), p.y)).r,
    getSourceColor(p).g,
    getSourceColor(vec2(clamp(p.x - lag, 0.0, 1.0), p.y)).b
  );

  return vec4(mix(base.rgb, clamp(c, 0.0, 1.0), intensity), base.a);
}

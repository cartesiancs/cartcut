uniform float amount;
uniform float bands;

float hash(float n) {
  return fract(sin(n * 127.1) * 43758.5453123);
}

// Horizontal bands tear sideways by different amounts and the channels come
// apart with them. The band index seeds the offset, so a band jumps as a unit
// rather than dissolving — which is what makes it read as a fault rather than
// as noise.
vec4 transition(vec2 uv) {
  float envelope = sin(progress * 3.14159265);
  float band = floor(uv.y * bands);
  // Re-seeded as progress advances so the tear pattern keeps changing.
  float jitter = (hash(band + floor(progress * 12.0)) - 0.5) * 2.0;
  float shift = jitter * amount * envelope;

  vec2 p = vec2(uv.x + shift, uv.y);
  float split = shift * 0.35;

  vec4 a = vec4(
    getFromColor(p + vec2(split, 0.0)).r,
    getFromColor(p).g,
    getFromColor(p - vec2(split, 0.0)).b,
    1.0
  );
  vec4 b = vec4(
    getToColor(p + vec2(split, 0.0)).r,
    getToColor(p).g,
    getToColor(p - vec2(split, 0.0)).b,
    1.0
  );
  return mix(a, b, progress);
}

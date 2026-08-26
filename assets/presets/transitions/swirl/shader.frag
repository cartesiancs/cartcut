uniform float turns;
uniform float radius;

const float TAU = 6.28318530718;

mat2 rotation(float angle) {
  float s = sin(angle);
  float c = cos(angle);
  return mat2(c, -s, s, c);
}

// The frame wrings itself out and unwinds into the next clip. The twist falls
// off with distance, so the centre spins hardest and the corners barely move —
// without that falloff it is a plain rotation, not a swirl.
vec4 transition(vec2 uv) {
  vec2 d = uv - 0.5;
  d.x *= ratio;
  float falloff = 1.0 - smoothstep(0.0, radius, length(d));
  float envelope = sin(progress * 3.14159265);
  float angle = turns * TAU * falloff * envelope;

  vec2 twisted = rotation(angle) * d;
  twisted.x /= ratio;
  vec2 p = twisted + 0.5;

  return mix(getFromColor(p), getToColor(p), progress);
}

uniform vec2 centre;
uniform float amplitude;
uniform float frequency;

// A stone dropped in the frame. Rings travel outward from the centre and the
// dissolve rides them, so the two clips exchange along a moving wavefront
// rather than uniformly.
vec4 transition(vec2 uv) {
  vec2 d = uv - centre;
  d.x *= ratio;
  float dist = length(d);

  // The wave front sweeps out past the far corner as progress runs, and the
  // envelope kills the ripple at both ends so each clip resolves clean.
  float front = progress * 1.5;
  float envelope = sin(progress * 3.14159265);
  float wave = sin((dist - front) * frequency) * amplitude * envelope;

  vec2 offset = normalize(d + vec2(0.0001)) * wave;
  vec4 a = getFromColor(uv + offset);
  vec4 b = getToColor(uv + offset);
  return mix(a, b, smoothstep(dist - 0.15, dist + 0.15, front));
}

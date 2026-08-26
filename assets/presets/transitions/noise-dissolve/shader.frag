uniform float grain;
uniform float softness;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Every pixel gets its own threshold, so the frame erodes into the next one
// grain by grain. The pattern is fixed for a given frame size — re-seeding it
// per frame would boil rather than dissolve.
vec4 transition(vec2 uv) {
  vec2 cell = floor(uv * vec2(grain * ratio, grain));
  float threshold = hash(cell);

  float edge = progress * (1.0 + 2.0 * softness) - softness;
  float m = smoothstep(edge - softness, edge + softness, threshold);
  return mix(getToColor(uv), getFromColor(uv), m);
}

uniform float vertical;
uniform float softness;

// Two edges parting from the centre line. Distance from the centre is the
// wipe coordinate, so one `smoothstep` opens both sides at once.
vec4 transition(vec2 uv) {
  float axis = vertical > 0.5 ? uv.y : uv.x;
  float fromCentre = abs(axis - 0.5) * 2.0;
  // Travels past both ends by `softness` so the doors actually finish opening
  // rather than leaving a soft fringe at progress 1.
  float edge = progress * (1.0 + 2.0 * softness) - softness;
  float m = smoothstep(edge - softness, edge + softness, fromCentre);
  return mix(getToColor(uv), getFromColor(uv), m);
}

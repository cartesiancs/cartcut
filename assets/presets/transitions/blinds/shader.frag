uniform float count;
uniform float vertical;
uniform float softness;

// Many small wipes running in parallel. `fract` turns the frame into `count`
// identical cells and the same edge sweeps every one of them at once.
vec4 transition(vec2 uv) {
  float axis = vertical > 0.5 ? uv.y : uv.x;
  float cell = fract(axis * count);
  float edge = progress * (1.0 + 2.0 * softness) - softness;
  float m = smoothstep(edge - softness, edge + softness, cell);
  return mix(getToColor(uv), getFromColor(uv), m);
}

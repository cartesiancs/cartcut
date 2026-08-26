uniform float dots;
uniform float softness;

// Dots on a regular grid swell until they meet and the incoming clip has taken
// the whole frame. The reveal coordinate is the distance to the nearest dot
// centre, which is what gives the rounded print-like edge.
vec4 transition(vec2 uv) {
  vec2 grid = vec2(dots * ratio, dots);
  vec2 inCell = fract(uv * grid) - 0.5;
  float toCentre = length(inCell) * 2.0;

  // A dot has to reach the cell corner to cover it, hence the sqrt(2) reach.
  float radius = progress * 1.4142;
  float m = smoothstep(radius - softness, radius + softness, toCentre);
  return mix(getToColor(uv), getFromColor(uv), m);
}

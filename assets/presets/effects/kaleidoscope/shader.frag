uniform float segments;
uniform float rotation;
uniform float zoom;
uniform vec2 centre;

const float TAU = 6.28318530718;

// One wedge of the frame reflected around a centre. Mirror folds across a
// straight line and keeps the composition; this works in polar coordinates and
// destroys it, which is a different picture and a different control set.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  float aspect = resolution.x / max(resolution.y, 1.0);
  vec2 d = vec2((uv.x - centre.x) * aspect, uv.y - centre.y);

  float angle = atan(d.y, d.x) + rotation;
  float radius = length(d) / max(zoom, 0.001);

  // Fold the angle into one wedge, then mirror alternate wedges so neighbours
  // meet at their edges instead of repeating with a seam.
  float wedge = TAU / max(segments, 2.0);
  float folded = mod(angle, wedge);
  folded = min(folded, wedge - folded);

  vec2 p = vec2(cos(folded), sin(folded)) * radius;
  vec2 at = vec2(p.x / aspect + centre.x, p.y + centre.y);

  // Reflect back inside rather than clamping, which would smear the border
  // colour across whole wedges.
  at = abs(at);
  at = mix(at, 2.0 - at, step(1.0, at));

  vec3 c = getSourceColor(clamp(at, 0.0, 1.0)).rgb;
  return vec4(mix(base.rgb, c, intensity), base.a);
}

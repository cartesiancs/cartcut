uniform float direction;

// The incoming clip grows in from an edge, whole, scaled to whatever band it
// currently occupies. `from` is never touched — that is what separates this
// from Stretch, where both clips are scaled and neither survives intact.
vec4 transition(vec2 uv) {
  float p = max(progress, 0.0001);
  vec2 t = uv;

  if (direction < 0.5) {
    if (uv.x > p) { return getFromColor(uv); }
    t.x = uv.x / p;
  } else if (direction < 1.5) {
    if (uv.x < 1.0 - p) { return getFromColor(uv); }
    t.x = (uv.x - (1.0 - p)) / p;
  } else if (direction < 2.5) {
    if (uv.y < 1.0 - p) { return getFromColor(uv); }
    t.y = (uv.y - (1.0 - p)) / p;
  } else {
    if (uv.y > p) { return getFromColor(uv); }
    t.y = uv.y / p;
  }

  return getToColor(t);
}

uniform float direction;

// The frame is shared: the incoming clip expands from one edge while the
// outgoing one is compressed against the other. Both are distorted and neither
// overlaps, which is the opposite trade from Squeeze.
vec4 transition(vec2 uv) {
  float p = clamp(progress, 0.0001, 0.9999);
  float axis;
  bool flip = false;

  if (direction < 0.5)      { axis = uv.x; }
  else if (direction < 1.5) { axis = 1.0 - uv.x; flip = true; }
  else if (direction < 2.5) { axis = 1.0 - uv.y; flip = true; }
  else                      { axis = uv.y; }

  bool horizontal = direction < 1.5;

  if (axis < p) {
    float s = axis / p;
    vec2 t = uv;
    float mapped = flip ? 1.0 - s : s;
    if (horizontal) { t.x = mapped; } else { t.y = mapped; }
    return getToColor(t);
  }

  float s = (axis - p) / (1.0 - p);
  vec2 t = uv;
  float mapped = flip ? 1.0 - s : s;
  if (horizontal) { t.x = mapped; } else { t.y = mapped; }
  return getFromColor(t);
}

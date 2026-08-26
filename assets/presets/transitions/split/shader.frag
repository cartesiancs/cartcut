uniform float vertical;

// The outgoing clip tears down the middle and its two halves slide apart,
// uncovering the incoming one in the widening gap. Both halves keep their own
// pixels — they translate rather than scale.
vec4 transition(vec2 uv) {
  float axis = vertical > 0.5 ? uv.y : uv.x;
  float halfGap = progress * 0.5;

  if (axis < 0.5 - halfGap) {
    vec2 t = uv;
    if (vertical > 0.5) { t.y += halfGap; } else { t.x += halfGap; }
    return getFromColor(t);
  }
  if (axis > 0.5 + halfGap) {
    vec2 t = uv;
    if (vertical > 0.5) { t.y -= halfGap; } else { t.x -= halfGap; }
    return getFromColor(t);
  }
  return getToColor(uv);
}

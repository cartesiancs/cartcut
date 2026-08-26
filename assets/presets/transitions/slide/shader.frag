uniform float direction;

// Worth reading next to a keyframe-based slide, because this is the whole
// argument for modelling a transition as a shader. Nothing here touches either
// clip's animation: A evaluates its own keyframes into one texture, B into
// another, and the slide is a sampling offset applied afterwards. A clip that
// was already animating its position keeps doing so, and the two compose.
vec4 transition(vec2 uv) {
  vec2 step;
  if (direction < 0.5)      { step = vec2(-1.0, 0.0); }
  else if (direction < 1.5) { step = vec2(1.0, 0.0); }
  else if (direction < 2.5) { step = vec2(0.0, 1.0); }
  else                      { step = vec2(0.0, -1.0); }

  vec2 fromUv = uv - step * progress;
  vec2 toUv = uv + step * (1.0 - progress);

  bool fromVisible =
    fromUv.x >= 0.0 && fromUv.x <= 1.0 && fromUv.y >= 0.0 && fromUv.y <= 1.0;

  return fromVisible ? getFromColor(fromUv) : getToColor(toUv);
}

uniform float direction;

// Both clips travel together, the outgoing one shouldered off the frame by the
// incoming one. The difference from Slide is that there `from` stays put; here
// nothing is stationary, which is what makes it read as a shove.
vec4 transition(vec2 uv) {
  vec2 axis;
  if (direction < 0.5)      { axis = vec2(1.0, 0.0); }
  else if (direction < 1.5) { axis = vec2(-1.0, 0.0); }
  else if (direction < 2.5) { axis = vec2(0.0, -1.0); }
  else                      { axis = vec2(0.0, 1.0); }

  vec2 fromUv = uv + axis * progress;
  vec2 toUv = uv + axis * (progress - 1.0);

  bool insideFrom =
    fromUv.x >= 0.0 && fromUv.x <= 1.0 &&
    fromUv.y >= 0.0 && fromUv.y <= 1.0;

  return insideFrom ? getFromColor(fromUv) : getToColor(toUv);
}

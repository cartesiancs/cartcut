uniform float direction;
uniform float softness;

vec4 transition(vec2 uv) {
  // A select parameter arrives as a float, so compare with a tolerance rather
  // than with equality — GLSL ES has no integer uniforms worth relying on.
  float axis;
  if (direction < 0.5)      { axis = uv.x; }
  else if (direction < 1.5) { axis = 1.0 - uv.x; }
  else if (direction < 2.5) { axis = uv.y; }
  else                      { axis = 1.0 - uv.y; }

  // The edge travels a little past both ends so that softness does not leave
  // a sliver of the outgoing clip at progress 1.
  float edge = progress * (1.0 + 2.0 * softness) - softness;
  float mixAmount = smoothstep(edge - softness, edge + softness, axis);
  return mix(getToColor(uv), getFromColor(uv), mixAmount);
}

uniform vec3 tint;
uniform float direction;
uniform float softness;

// Film fogged by light entering round the back of the camera: a coloured wash
// that sweeps across the frame and takes the cut with it. Flash is uniform and
// white; this has a direction, a colour, and a soft edge that wipes.
vec4 transition(vec2 uv) {
  float axis;
  if (direction < 0.5)      { axis = uv.x; }
  else if (direction < 1.5) { axis = 1.0 - uv.x; }
  else if (direction < 2.5) { axis = 1.0 - uv.y; }
  else                      { axis = uv.y; }

  // The leak front runs ahead of the cut, so the incoming clip is already
  // arriving inside the glow rather than appearing after it has passed.
  float front = progress * (1.0 + softness * 2.0) - softness;
  float wipe = smoothstep(front - softness, front + softness, axis);
  vec4 base = mix(getToColor(uv), getFromColor(uv), wipe);

  // Brightest at the front itself and falling away on both sides.
  float glow = exp(-pow((axis - front) / max(softness, 0.001), 2.0) * 2.0);
  float envelope = sin(clamp(progress, 0.0, 1.0) * 3.14159265);
  return vec4(base.rgb + tint * glow * envelope * 1.2, 1.0);
}

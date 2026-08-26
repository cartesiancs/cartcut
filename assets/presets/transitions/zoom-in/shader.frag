uniform float amount;

// The outgoing clip rushes towards the viewer and dissolves as it goes, so the
// cut lands on the incoming clip at rest. Only `from` is scaled — `to` never
// moves, which is what makes the motion feel like leaving rather than arriving.
vec4 transition(vec2 uv) {
  float scale = 1.0 + amount * progress;
  vec2 fromUv = (uv - 0.5) / scale + 0.5;
  return mix(getFromColor(fromUv), getToColor(uv), progress);
}

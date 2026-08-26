uniform float amount;
uniform float radius;
uniform vec3 tint;

// An adjustment layer: `source` is everything already composited beneath this
// effect's track, which is what makes moving the track up or down change what
// the effect applies to.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  vec2 centred = uv - 0.5;
  // Correct for the frame's aspect so the falloff stays circular on a wide
  // canvas instead of stretching into an ellipse.
  float aspect = resolution.x / max(resolution.y, 1.0);
  centred.x *= aspect;

  float distance = length(centred) / max(radius, 0.001);
  float falloff = smoothstep(0.5, 1.0, distance) * amount * intensity;

  return vec4(mix(base.rgb, tint, clamp(falloff, 0.0, 1.0)), base.a);
}

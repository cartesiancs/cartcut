uniform vec3 tint;
uniform float width;
uniform float angle;
uniform float period;

// A specular band travelling across the frame, the way a highlight crosses
// glass or brushed metal. Additive, so it reads as light falling on the shot
// rather than as a wipe across it.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  // Project onto the sweep axis, aspect-corrected so the band stays straight.
  float aspect = resolution.x / max(resolution.y, 1.0);
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  float along = p.x * cos(angle) + p.y * sin(angle);

  // Travel far enough either side that the band is fully off-frame between
  // passes, rather than reappearing at the edge it left from.
  float span = aspect + 1.0 + width * 2.0;
  float head = fract(time / max(period, 0.001)) * span - span * 0.5;

  float band = exp(-pow((along - head) / max(width, 0.001), 2.0) * 2.0);

  vec3 c = base.rgb + tint * band * 0.85;
  return vec4(mix(base.rgb, clamp(c, 0.0, 1.0), intensity), base.a);
}

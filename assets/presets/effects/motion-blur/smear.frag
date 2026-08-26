uniform float blurLength;
uniform float angle;

// A directional box smear — a camera panning, or a shutter left open. Uniform
// weights rather than gaussian ones, because a shutter is open for a fixed
// interval and every instant in it contributes equally. That flat profile is
// what makes this look like movement rather than like softness, and it is why
// the separable gaussian the other blur presets share is the wrong kernel here.
vec4 effect(vec2 uv) {
  vec2 axis = vec2(cos(angle), sin(angle));
  vec2 step = axis * blurLength / resolution / 12.0;

  vec3 c = vec3(0.0);
  for (int i = -12; i <= 12; i++) {
    c += getSourceColor(clamp(uv + step * float(i), 0.0, 1.0)).rgb;
  }

  return vec4(c / 25.0, 1.0);
}

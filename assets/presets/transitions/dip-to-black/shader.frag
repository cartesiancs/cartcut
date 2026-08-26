// Parameters are declared by the preset, exactly as they are upstream — the
// wrapper must not emit a second declaration or the shader will not compile.
uniform vec3 dipColor;

vec4 transition(vec2 uv) {
  // Out to the colour across the first half, in from it across the second.
  float half1 = smoothstep(0.0, 0.5, progress);
  float half2 = smoothstep(0.5, 1.0, progress);
  vec4 dip = vec4(dipColor, 1.0);
  return mix(mix(getFromColor(uv), dip, half1), getToColor(uv), half2);
}

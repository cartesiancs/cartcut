// The simplest transition there is, and the reference for the contract:
// the host supplies getFromColor, getToColor and progress; the preset
// supplies exactly one function.
vec4 transition(vec2 uv) {
  return mix(getFromColor(uv), getToColor(uv), progress);
}

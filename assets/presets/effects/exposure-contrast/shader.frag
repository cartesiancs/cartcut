uniform float exposure;
uniform float contrast;
uniform float pivot;

// Exposure in stops, because that is the unit the number came from: +1 is twice
// the light. Contrast pivots about a chosen value rather than about 0.5, so
// pushing a dark shot does not drag everything towards mid grey.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  vec3 c = base.rgb * pow(2.0, exposure);
  c = (c - pivot) * contrast + pivot;

  return vec4(mix(base.rgb, clamp(c, 0.0, 1.0), intensity), base.a);
}

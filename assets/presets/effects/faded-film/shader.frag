uniform float fade;
uniform float rolloff;
uniform vec3 wash;

// Old print: the blacks have drifted up off zero and the highlights have
// stopped climbing. That crushed-both-ends curve is the look, and it is not
// something a contrast control can reach — contrast pivots, this compresses.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);

  // Blacks lift towards the wash colour rather than towards grey, because dye
  // fades to its own cast.
  vec3 c = mix(base.rgb, wash, fade * 0.35);
  float floorLevel = fade * 0.12;
  c = floorLevel + c * (1.0 - floorLevel);

  // Highlights bend over instead of clipping.
  c = mix(c, 1.0 - pow(1.0 - c, vec3(1.0 + rolloff * 2.0)), rolloff);

  return vec4(mix(base.rgb, clamp(c, 0.0, 1.0), intensity), base.a);
}

uniform float strength;
uniform float skinProtect;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// The blockbuster grade, as one control rather than as three wheels set by
// hand. It is a hue rotation, not a tint: warm hues are pulled towards orange
// and everything else towards teal, so the separation survives a picture that
// was not shot with it in mind. Split Tone keys on brightness and cannot do
// that.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);
  float l = dot(base.rgb, LUMA);
  vec3 chroma = base.rgb - l;

  // How warm this pixel already is, -1..1.
  float warmth = clamp((base.r - base.b) * 2.0, -1.0, 1.0);
  float toward = smoothstep(-0.2, 0.5, warmth);

  vec3 orange = vec3(0.55, 0.12, -0.35);
  vec3 teal = vec3(-0.35, 0.05, 0.42);
  vec3 push = mix(teal, orange, toward);

  // Skin sits in the warm range and is the first thing to go wrong. Backing off
  // where the pixel is already close to skin keeps faces out of the grade.
  float skin = smoothstep(0.25, 0.6, warmth) * smoothstep(0.15, 0.5, l);
  float gain = strength * (1.0 - skin * skinProtect);

  vec3 c = l + chroma + push * gain * 0.35;
  return vec4(mix(base.rgb, clamp(c, 0.0, 1.0), intensity), base.a);
}

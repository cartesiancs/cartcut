uniform float axis;
uniform float position;

// A single straight fold, with the line where you put it. The symmetry is the
// point, so the mirror line is a parameter rather than fixed at the centre —
// off-centre is what makes a face symmetric about its own nose rather than
// about the frame.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);
  vec2 at = uv;

  bool vertical = axis > 1.5;
  float coord = vertical ? uv.y : uv.x;
  // Whether the kept half is the low side of the line or the high side.
  bool keepLow = (axis == 0.0 || axis == 2.0);

  bool reflect = keepLow ? coord > position : coord < position;
  if (reflect) {
    float folded = 2.0 * position - coord;
    if (vertical) { at.y = folded; } else { at.x = folded; }
  }

  // Outside the source after folding — the kept half was smaller than the one
  // it has to cover — there is nothing to reflect, so leave the picture alone.
  if (at.x < 0.0 || at.x > 1.0 || at.y < 0.0 || at.y > 1.0) {
    return base;
  }

  vec3 c = getSourceColor(at).rgb;
  return vec4(mix(base.rgb, c, intensity), base.a);
}

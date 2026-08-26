uniform float vertical;
uniform float shade;

const float CAMERA_D = 3.2;
const float FOCAL = 2.2;

// The outgoing clip splits down the middle and the two halves swing towards the
// viewer on their outer edges, opening onto the incoming one.
//
// Done analytically rather than with a mesh, because the forward projection
// inverts in closed form. A grid would have to tear at the seam to give the two
// halves their separate hinges; this does not.
//
// The closed panel lies on the same resting plane as every other 3D preset
// here, at depth 1 — that is what makes it exactly fill the frame at progress
// zero. A pixel at screen coordinate `x` therefore sits at panel coordinate `u`
// where
//
//   x = FOCAL * (-1 + 2 u cos a) / (CAMERA_D - 1 - 2 u sin a)
//
// and since CAMERA_D - 1 is FOCAL, that rearranges to
//
//   u = FOCAL (x + 1) / (2 (FOCAL cos a + x sin a))
//
// which is one division. Leaving the panel at depth 0 instead — the earlier
// mistake — scales it by FOCAL/CAMERA_D, so a closed door covered only 69% of
// the frame and the transition began with the incoming clip already showing
// down both edges.
vec4 transition(vec2 uv) {
  vec2 p = vertical > 0.5 ? uv.yx : uv;
  // Screen coordinate the projection is written in.
  float x = p.x * 2.0 - 1.0;
  float angle = progress * 1.4;
  float c = cos(angle);
  float s = sin(angle);

  // Mirror the right half onto the left so one solve covers both.
  float sign = x < 0.0 ? 1.0 : -1.0;
  float mirrored = x * sign;

  float denom = 2.0 * (FOCAL * c + mirrored * s);
  if (abs(denom) < 0.0001) {
    return getToColor(uv);
  }
  float along = FOCAL * (mirrored + 1.0) / denom;

  if (along < 0.0 || along > 0.5) {
    // Past the panel's inner edge: the doorway itself.
    return getToColor(uv);
  }

  // Back to the panel's own texture coordinate.
  float u = 0.5 + sign * (along - 0.5);
  vec2 sampleUv = vertical > 0.5 ? vec2(p.y, u) : vec2(u, p.y);
  vec4 colour = getFromColor(sampleUv);

  // The panels turn away from the light as they open.
  return vec4(colour.rgb * mix(1.0, c, shade), colour.a);
}

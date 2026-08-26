uniform float radius;
uniform float shade;

const float PI = 3.14159265;

// The outgoing clip is a sheet of paper rolled off the frame, uncovering the
// incoming one underneath.
//
// ## Why this is not a mesh
//
// A grid was the obvious tool and it is the wrong one: a mesh paints only where
// its triangles land, so every pixel the sheet rolls away from is left clear —
// and that region is exactly where `to` has to appear. Inverting the fold
// instead covers the whole frame, and picks the nearest surface per pixel rather
// than leaning on a depth buffer.
//
// ## The fold
//
// The sheet is flat up to a moving line, wraps a half-cylinder of radius r, and
// lies back flat beyond it. Along the page, at distance `u` from the left edge:
//
//   u <= axis          flat, on the page          x = u,                z = 0
//   axis < u <= axis+pi*r  on the cylinder        x = axis + r sin(t),  z = r(1-cos t)
//   u > axis+pi*r      the flap, lying back       x = 2 axis + pi r - u, z = 2r
//
// Each is invertible, so a screen x yields at most three candidate points on the
// sheet and the nearest one — largest z — is what the eye sees.
vec4 transition(vec2 uv) {
  vec4 beneath = getToColor(uv);

  float r = max(radius, 0.001);
  float arc = PI * r;
  // The line sweeps right to left, far enough past the edge that the sheet has
  // wholly left the frame by the end.
  float axis = 1.0 - progress * (2.0 + arc);

  float x = uv.x * 2.0 - 1.0;

  if (x >= axis) {
    // Only the cylinder reaches in front of the line. Two arcs of it project
    // here — the near side and the far side — and the near side wins.
    float k = (x - axis) / r;
    if (k > 1.0) {
      // Just past the roll's silhouette, the incoming clip is in its shadow.
      // Without this the sheet and what is behind it sit in the same plane and
      // the whole thing reads as a wipe with an odd-coloured edge.
      float past = (x - axis) / r - 1.0;
      float shadow = exp(-past * 2.5) * 0.55 * shade;
      return vec4(beneath.rgb * (1.0 - shadow), beneath.a);
    }
    float theta = PI - asin(clamp(k, 0.0, 1.0));
    float u = axis + theta * r;
    if (u > 1.0) {
      // The roll has not reached this far along the page yet, so what is here
      // is the near arc instead.
      theta = asin(clamp(k, 0.0, 1.0));
      u = axis + theta * r;
      if (u > 1.0 || u < -1.0) {
        return beneath;
      }
    }
    vec4 sheet = getFromColor(vec2(u * 0.5 + 0.5, uv.y));
    // Lambert against a light behind the camera. Without it the roll reads as a
    // flat cut-out rather than as a curved surface.
    float lit = cos(theta) * 0.5 + 0.5;
    if (theta > PI * 0.5) {
      // Past the quarter turn we are looking at the reverse of the page: the
      // same picture, dimmed and drained the way a printed back is.
      float grey = dot(sheet.rgb, vec3(0.299, 0.587, 0.114));
      vec3 back = mix(sheet.rgb, vec3(grey), 0.35) * mix(1.0, 0.7, shade);
      return vec4(back, 1.0);
    }
    return vec4(sheet.rgb * mix(1.0, lit, shade), 1.0);
  }

  // Behind the line: the flap lies over the flat remainder, so try it first.
  float flap = 2.0 * axis + arc - x;
  if (flap <= 1.0) {
    vec4 sheet = getFromColor(vec2(flap * 0.5 + 0.5, uv.y));
    float grey = dot(sheet.rgb, vec3(0.299, 0.587, 0.114));
    vec3 back = mix(sheet.rgb, vec3(grey), 0.35) * mix(1.0, 0.7, shade);
    return vec4(back, 1.0);
  }
  if (x < -1.0) {
    return beneath;
  }
  // The part of the page still lying flat, untouched.
  return getFromColor(uv);
}

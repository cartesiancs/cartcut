uniform float shade;

varying float vFace;
varying float vFacing;

// A box turning between two clips. The two faces genuinely occlude each other
// through the depth buffer rather than being ordered by hand, which is why the
// mesh carries a depth attachment.
//
// The corners the cube does not cover are left clear on purpose: a solid turning
// in space does not fill a rectangular frame, and painting something there would
// be inventing a fifth face.
vec4 transition(vec2 uv) {
  vec4 colour = vFace < 0.5 ? getFromColor(uv) : getToColor(uv);
  // Without this the cube reads as two sliding rectangles. Darkening by how far
  // a face has turned away is what makes it read as a solid.
  float lit = mix(1.0, vFacing, shade);
  return vec4(colour.rgb * lit, colour.a);
}

attribute vec2 _p;

varying vec2 _uv;
varying float vFacing;

uniform float progress;
uniform float vertical;

// A camera on the +d axis looking back at the origin. `FOCAL` is chosen so a
// face sitting at d = 1 projects exactly to the -1..1 square — that is, the
// resting frame fills the screen and no 3D transition starts or ends with a
// visible seam.
const float CAMERA_D = 3.2;
const float FOCAL = 2.2;

// Deliberately no perspective divide here: writing w and letting GL do it is
// what makes the varyings perspective-correct. Doing it by hand gives an
// affine-textured plane, which looks subtly wrong exactly when the angle is
// steepest.
vec4 project(vec3 p) {
  float w = CAMERA_D - p.z;
  // z is scaled arbitrarily; only its order matters, and this keeps every
  // depth in -1..1 for the range the presets use.
  return vec4(p.x * FOCAL, p.y * FOCAL, -p.z * FOCAL * 0.25, w);
}

void main() {
  // A single plane, so the host quad is geometry enough — no mesh, no depth.
  // Half a turn: the sheet passes edge-on at the midpoint and finishes with its
  // back to us.
  float angle = progress * 3.14159265;
  float c = cos(angle);
  float s = sin(angle);

  vec3 local = vertical > 0.5
    ? vec3(_p.x, _p.y * c, -_p.y * s)
    : vec3(_p.x * c, _p.y, -_p.x * s);

  gl_Position = project(local);

  _uv = _p * 0.5 + 0.5;
  vFacing = abs(c);
}

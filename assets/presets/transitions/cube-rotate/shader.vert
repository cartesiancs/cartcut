attribute vec2 _p;

varying vec2 _uv;
// Which clip this face carries, and how square-on it is. The fragment shader
// cannot work either out from `_uv` alone.
varying float vFace;
varying float vFacing;

uniform float progress;
uniform float direction;

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
  // `cubeGeometry` displaces the second face by 4 along x, which is the only
  // way a vec2 attribute can carry a face index. See its documentation.
  float face = step(2.0, _p.x);
  vec2 corner = vec2(_p.x - face * 4.0, _p.y);

  bool vertical = direction > 1.5;
  // Which side the incoming face swings in from.
  float side = (direction == 1.0 || direction == 2.0) ? 1.0 : -1.0;

  // Work in (travel, other, depth). `travel` is the axis the content moves
  // along, so the vertical directions are the horizontal ones with x and y
  // exchanged — the rotation itself is written once.
  float travel = vertical ? corner.y : corner.x;
  float other = vertical ? corner.x : corner.y;

  // The outgoing face is square-on at depth 1; the incoming one stands edge-on
  // at travel = ±1 and spans depth, so a quarter turn brings it to the front.
  vec3 local = face < 0.5
    ? vec3(travel, other, 1.0)
    : vec3(side, other, -side * travel);

  float angle = -side * progress * 1.57079632679;
  float c = cos(angle);
  float s = sin(angle);
  vec3 turned = vec3(
    local.x * c + local.z * s,
    local.y,
    -local.x * s + local.z * c
  );

  vec3 world = vertical
    ? vec3(turned.y, turned.x, turned.z)
    : turned;

  gl_Position = project(world);

  _uv = (vertical ? vec2(other, travel) : vec2(travel, other)) * 0.5 + 0.5;
  vFace = face;
  // A face turned away from the camera catches less light. Its normal starts
  // along +d and turns with it, so the cosine is just the rotated z.
  vec3 normal = face < 0.5
    ? vec3(s, 0.0, c)
    : vec3(side * c, 0.0, side * s);
  vFacing = clamp(abs(normal.z), 0.0, 1.0);
}

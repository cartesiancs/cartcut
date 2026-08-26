uniform float vertical;
uniform float amplitude;
uniform float frequency;

// A standing sine shears the frame across the cut. Unlike Ripple there is no
// centre and no travelling front: every row displaces by the same rule, which
// reads as a fabric ruffle rather than as an impact.
vec4 transition(vec2 uv) {
  float along = vertical > 0.5 ? uv.x : uv.y;
  float envelope = sin(progress * 3.14159265);
  float shift = sin(along * frequency + progress * 6.28318530718)
              * amplitude * envelope;

  vec2 offset = vertical > 0.5 ? vec2(0.0, shift) : vec2(shift, 0.0);
  vec4 a = getFromColor(uv + offset);
  vec4 b = getToColor(uv + offset);
  return mix(a, b, progress);
}

uniform float spread;
uniform float angle;

// The three channels pull apart along one axis and come back together on the
// other side of the cut. No band structure and no jitter — a clean optical
// separation, where Glitch is a broken signal.
vec4 transition(vec2 uv) {
  float envelope = sin(progress * 3.14159265);
  vec2 axis = vec2(cos(angle), sin(angle)) * spread * envelope;

  vec4 a = vec4(
    getFromColor(uv + axis).r,
    getFromColor(uv).g,
    getFromColor(uv - axis).b,
    1.0
  );
  vec4 b = vec4(
    getToColor(uv + axis).r,
    getToColor(uv).g,
    getToColor(uv - axis).b,
    1.0
  );
  return mix(a, b, progress);
}

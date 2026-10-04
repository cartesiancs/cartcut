// Film grain. Two octaves of cell noise, re-dealt `rate` times a second, so
// the grain holds still for a frame the way film does rather than shimmering
// at the export rate.
//
// `cover` is how much of the base colour is painted. At 1 this is a grainy
// background; at 0 only the grain itself is drawn, light specks and dark specks
// with an alpha of their strength, to lay over footage.

uniform vec3 base;
uniform float amount;
uniform float grain;
uniform float rate;
uniform float cover;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec4 graphic(vec2 uv) {
  float frame = floor(time * rate);
  vec2 cell = floor(uv * resolution / max(grain, 1.0));
  float fine = hash(cell + frame * vec2(37.0, 17.0));
  float coarse = hash(floor(cell * 0.5) + frame * vec2(11.0, 53.0));
  float g = fine * 0.65 + coarse * 0.35 - 0.5;

  vec3 tinted = clamp(base + g * amount, 0.0, 1.0);
  vec3 speck = vec3(step(0.0, g));
  float alpha = mix(clamp(abs(g) * 2.0 * amount, 0.0, 1.0), 1.0, cover);
  return vec4(mix(speck, tinted, cover), alpha);
}

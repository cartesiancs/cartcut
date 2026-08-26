uniform vec3 ember;
uniform float scale;
uniform float width;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Value noise. The burn front has to be ragged, and a smooth field is what
// makes it ragged in fist-sized clumps rather than pixel by pixel — which is
// the difference between paper catching and static.
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

// The outgoing clip burns away and the incoming one is behind it. Where Noise
// Dissolve thresholds per pixel and has no edge, this one keeps a coherent
// front and sets it alight.
vec4 transition(vec2 uv) {
  float field = noise(vec2(uv.x * ratio, uv.y) * scale);
  // A little bias towards the left so the burn starts somewhere rather than
  // opening everywhere at once.
  field = field * 0.75 + uv.x * 0.25;

  // The front runs past both ends by `width`, so the frame is fully alight at
  // no point and fully resolved at both.
  float front = progress * (1.0 + width * 2.0) - width;
  float burnt = smoothstep(front + width, front - width, field);

  vec4 base = mix(getFromColor(uv), getToColor(uv), burnt);

  // The ember band is the part of the front that is neither burnt nor whole.
  float edge = burnt * (1.0 - burnt) * 4.0;
  vec3 glow = ember * pow(edge, 1.5) * 2.2;
  // Charring just behind the ember, before the incoming clip takes over.
  float char = clamp(edge * 0.6, 0.0, 1.0);

  return vec4(base.rgb * (1.0 - char) + glow, 1.0);
}

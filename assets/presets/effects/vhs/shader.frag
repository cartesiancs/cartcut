uniform float tracking;
uniform float bleed;
uniform float wobble;

float hash(float n) {
  return fract(sin(n * 127.1) * 43758.5453123);
}

// Tape, which fails in three ways at once and only reads as tape when all three
// are present: the head wanders so lines shift sideways, chroma is recorded at
// a fraction of the luma bandwidth so colour smears rightward, and the tracking
// band crawls up the picture. Splitting them into three presets would mean
// nobody could reach the actual look.
vec4 effect(vec2 uv) {
  // Row-wise jitter. Quantised to a scanline so it tears in lines, not smoothly.
  float row = floor(uv.y * resolution.y);
  float jitter = (hash(row + floor(time * 20.0)) - 0.5) * 0.02 * wobble;

  // The tracking band: a region of much heavier displacement crawling upward.
  float band = fract(uv.y + time * 0.15);
  float inBand = smoothstep(0.06, 0.0, abs(band - 0.5)) * tracking;
  jitter += inBand * (hash(row * 1.7) - 0.5) * 0.12;

  vec2 p = vec2(clamp(uv.x + jitter, 0.0, 1.0), uv.y);
  vec4 base = getSourceColor(p);

  // Chroma lags luma: the colour is sampled from further left, so edges trail
  // their colour to the right.
  float lag = 0.006 * bleed;
  vec3 c = vec3(
    getSourceColor(vec2(clamp(p.x - lag, 0.0, 1.0), p.y)).r,
    base.g,
    getSourceColor(vec2(clamp(p.x + lag * 0.5, 0.0, 1.0), p.y)).b
  );

  // Luma noise concentrated in the band, where the signal is weakest.
  c += (hash(row * 3.3 + floor(time * 30.0)) - 0.5) * 0.12 * inBand;

  vec4 untouched = getSourceColor(uv);
  return vec4(mix(untouched.rgb, clamp(c, 0.0, 1.0), intensity), untouched.a);
}

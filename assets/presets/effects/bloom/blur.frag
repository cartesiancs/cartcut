uniform vec2 dir;
uniform float radius;
// 0 on an axis's first pass, 1 on its second.
uniform float stage;

// A gaussian sampled at gaps wider than a texel is a sum of shifted copies of
// the picture rather than a blur. This file used to take nine taps `radius`
// texels apart, so past a few texels every edge came out as 81 ghosts on a
// lattice once both axes had run. Every tap here is either one texel from the
// next, or reads a picture the previous pass has already smoothed enough to be
// sampled that sparsely.
//
// Each axis takes two passes and the variances add, so together they are one
// gaussian of the full sigma. Stage 0 is dense: every texel out to three sigma,
// two per fetch by letting the linear filter weigh a pair. Stage 1 spaces its
// taps 1.5 of stage 0's sigma apart, a gap at which stage 0 has left 2e-4 of
// the picture's detail above the lattice's frequency, a fraction of one 8-bit
// level. Each pass then costs about sqrt(3 * sigma) fetches per side, 21 at the
// largest radius any preset allows.

// The standard deviation, in units of `radius`, of the nine-tap kernel this
// replaced. Keeping it keeps every saved project's blur the same size.
const float SIGMA_PER_RADIUS = 1.6894;

// Fetches per side, per pass. Loop bounds must be constant in GLSL ES 1.0; the
// cap holds a radius up to about 200 before the kernel starts being truncated.
const int MAX_TAPS = 32;

vec3 tap(vec2 uv) {
  return getSourceColor(clamp(uv, 0.0, 1.0)).rgb;
}

// Texels 2i+1 and 2i+2 in one fetch, placed between them in proportion to
// their weights. Exact because each output pixel sits on a source texel centre:
// the passes run at the resolution they read.
vec3 dense(vec2 uv, vec2 texel, float sigma) {
  float k = -0.5 / (sigma * sigma);
  float reach = ceil(3.0 * sigma);
  vec3 sum = tap(uv);
  float total = 1.0;
  for (int i = 0; i < MAX_TAPS; i++) {
    float a = float(2 * i + 1);
    if (a > reach) break;
    float wa = exp(a * a * k);
    float wb = exp((a + 1.0) * (a + 1.0) * k);
    float w = wa + wb;
    vec2 offset = texel * (a + wb / w);
    sum += (tap(uv + offset) + tap(uv - offset)) * w;
    total += 2.0 * w;
  }
  return sum / total;
}

vec3 sparse(vec2 uv, vec2 texel, float sigma, float gap) {
  float k = -0.5 / (sigma * sigma);
  float count = ceil(3.0 * sigma / gap);
  vec3 sum = tap(uv);
  float total = 1.0;
  for (int i = 1; i <= MAX_TAPS; i++) {
    float n = float(i);
    if (n > count) break;
    float d = n * gap;
    float w = exp(d * d * k);
    vec2 offset = texel * d;
    sum += (tap(uv + offset) + tap(uv - offset)) * w;
    total += 2.0 * w;
  }
  return sum / total;
}

// No `intensity` anywhere in here: it is applied once, by the pass that puts
// the result back against `original`. Fading on every step would apply it
// four times over.
vec4 effect(vec2 uv) {
  float sigma = max(radius, 0.0) * SIGMA_PER_RADIUS;
  // The split that spends the fewest fetches: stage 0 costs 1.5 * s0 per side
  // and stage 1 about 2 * sigma / s0, equal at s0 = sqrt(4 * sigma / 3).
  float s0 = min(sigma, sqrt(sigma * 4.0 / 3.0));
  float s1 = sqrt(max(sigma * sigma - s0 * s0, 0.0));

  float s = stage < 0.5 ? s0 : s1;
  if (s < 0.01) {
    return vec4(getSourceColor(uv).rgb, 1.0);
  }

  vec2 texel = dir / resolution;
  if (stage < 0.5) {
    return vec4(dense(uv, texel, s), 1.0);
  }
  // Never wider than stage 1's own sigma either: a gaussian sampled at gaps
  // wider than its sigma has lost part of its variance, and the two passes
  // would no longer add up to `sigma`.
  return vec4(sparse(uv, texel, s, min(1.5 * s0, s)), 1.0);
}

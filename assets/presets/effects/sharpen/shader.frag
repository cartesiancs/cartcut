uniform float amount;
uniform float radius;

// Unsharp mask: the picture plus its own difference from a blurred copy. One
// pass is enough because the blur here is deliberately tiny — a wide radius is
// what Gaussian Blur is for, and chaining the two is the honest way to get a
// wide-radius sharpen.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);
  vec2 step = radius / resolution;

  // A 3x3 tent, which is the smallest kernel with no directional bias.
  vec3 blurred =
    getSourceColor(clamp(uv + vec2(-step.x, -step.y), 0.0, 1.0)).rgb * 0.0625 +
    getSourceColor(clamp(uv + vec2(0.0, -step.y), 0.0, 1.0)).rgb * 0.125 +
    getSourceColor(clamp(uv + vec2(step.x, -step.y), 0.0, 1.0)).rgb * 0.0625 +
    getSourceColor(clamp(uv + vec2(-step.x, 0.0), 0.0, 1.0)).rgb * 0.125 +
    base.rgb * 0.25 +
    getSourceColor(clamp(uv + vec2(step.x, 0.0), 0.0, 1.0)).rgb * 0.125 +
    getSourceColor(clamp(uv + vec2(-step.x, step.y), 0.0, 1.0)).rgb * 0.0625 +
    getSourceColor(clamp(uv + vec2(0.0, step.y), 0.0, 1.0)).rgb * 0.125 +
    getSourceColor(clamp(uv + vec2(step.x, step.y), 0.0, 1.0)).rgb * 0.0625;

  vec3 c = base.rgb + (base.rgb - blurred) * amount;
  return vec4(mix(base.rgb, clamp(c, 0.0, 1.0), intensity), base.a);
}

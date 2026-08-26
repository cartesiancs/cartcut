uniform float strength;
uniform float edgeThreshold;
uniform float overlay;
uniform vec3 lineColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float lumaAt(vec2 uv) {
  return dot(getSourceColor(clamp(uv, 0.0, 1.0)).rgb, LUMA);
}

// Sobel. Sharpen amplifies the same differences and puts them back; this keeps
// only the gradient magnitude and throws the picture away — which is why the
// `overlay` option exists rather than a second preset.
vec4 effect(vec2 uv) {
  vec4 base = getSourceColor(uv);
  vec2 s = 1.0 / resolution;

  float tl = lumaAt(uv + vec2(-s.x, -s.y));
  float tc = lumaAt(uv + vec2(0.0, -s.y));
  float tr = lumaAt(uv + vec2(s.x, -s.y));
  float ml = lumaAt(uv + vec2(-s.x, 0.0));
  float mr = lumaAt(uv + vec2(s.x, 0.0));
  float bl = lumaAt(uv + vec2(-s.x, s.y));
  float bc = lumaAt(uv + vec2(0.0, s.y));
  float br = lumaAt(uv + vec2(s.x, s.y));

  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
  float edge = length(vec2(gx, gy)) * strength;
  edge = smoothstep(edgeThreshold, edgeThreshold + 0.15, edge);

  vec3 c = overlay > 0.5
    ? mix(base.rgb, lineColor, edge)
    : lineColor * edge;

  return vec4(mix(base.rgb, clamp(c, 0.0, 1.0), intensity), base.a);
}

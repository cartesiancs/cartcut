precision mediump float;

uniform sampler2D u_texture;
uniform float amount;
varying vec2 _uv;

void main() {
  vec4 source = texture2D(u_texture, _uv);
  vec3 lifted = source.rgb + amount * source.rgb * (1.0 - source.rgb);
  gl_FragColor = vec4(lifted, source.a);
}

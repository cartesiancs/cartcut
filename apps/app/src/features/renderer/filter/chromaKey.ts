import { BaseQuadFilter } from "./baseFilter";

const vertexShaderSource = `
  attribute vec2 a_position;
  attribute vec2 a_texCoord;
  varying vec2 v_texCoord;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = a_texCoord;
  }
`;
const fragmentShaderSource = `
  precision mediump float;
  uniform sampler2D u_video;
  uniform vec3 u_keyColor;
  uniform float u_threshold;
  varying vec2 v_texCoord;
  void main() {
    vec4 color = texture2D(u_video, v_texCoord);
    float diff = distance(color.rgb, u_keyColor);
    if(diff < u_threshold) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    } else {
      gl_FragColor = color;
    }
  }
`;

/**
 * Parse a chromakey parameter string such as `"r=0:g=255:b=0:f=0.4"`.
 *
 * `f` is the match threshold and defaults to 1, which keys out everything; the
 * channels are 0..255. Exported so the parsing can be tested without a WebGL
 * context — the shader around it cannot run in Node.
 */
export function parseRGBString(str: string) {
  const parts = str.split(":");

  let r = 0,
    g = 0,
    b = 0,
    f = 1;

  parts.forEach((item) => {
    const [key, value] = item.split("=");
    const numValue = parseFloat(value);

    switch (key) {
      case "r":
        r = numValue;
        break;
      case "g":
        g = numValue;
        break;
      case "b":
        b = numValue;
        break;
      case "f":
        f = numValue;
        break;
      default:
        break;
    }
  });

  return { r, g, b, f };
}

export class ChromaKey extends BaseQuadFilter<string> {
  u_keyColor: WebGLUniformLocation | null;
  u_threshold: WebGLUniformLocation | null;

  constructor(gl: WebGLRenderingContext) {
    super(gl, vertexShaderSource, fragmentShaderSource, "u_video");

    this.u_keyColor = gl.getUniformLocation(this.program, "u_keyColor");
    this.u_threshold = gl.getUniformLocation(this.program, "u_threshold");
  }

  draw(data: string, targetTexture: WebGLTexture): void {
    const gl = this.gl;

    this.prepareDraw(targetTexture);

    const parsedRgb = parseRGBString(data);
    const keyColor = [parsedRgb.r / 255, parsedRgb.g / 255, parsedRgb.b / 255];
    const thresholdForce = parsedRgb.f;
    gl.uniform3fv(this.u_keyColor, keyColor);
    gl.uniform1f(this.u_threshold, thresholdForce);

    super.draw(data, targetTexture);
  }
}

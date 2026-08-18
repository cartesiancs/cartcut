/**
 * WebGL video filters (chromakey / blur / radial blur).
 *
 * Ported from the preview's own copy, which now imports this instead. The two
 * copies still inlined in controllers/render.ts and offscreen-render.ts are
 * replaced by this one when those files are cut over to the shared frame loop.
 *
 * This keeps the *preview's* behaviour, which differs from the export copies:
 * the chromakey threshold comes from the filter string's `f` parameter instead
 * of being hard-coded to 0.5, so the threshold control will finally affect
 * exported video. The GLSL is otherwise byte-identical across all three.
 *
 * This is inherently browser-only (needs a real WebGL context); it is not
 * exercised by the Node canvas tests. The pure parameter parsing it relies on
 * (`parseRGBString` / `parseBlurString`) lives in ./parseFilter and *is* tested.
 */

import { parseRGBString, parseBlurString } from "./parseFilter";
import type { CanvasCtx, VideoHandle } from "../render/types";

function createShader(gl: any, type: number, source: string) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("셰이더 컴파일 에러:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

type FilterFn = (
  ctx: CanvasCtx,
  video: VideoHandle,
  videoElement: any,
  w: number,
  h: number,
  scaleX: number,
  scaleY: number,
  scaleW: number,
  scaleH: number,
  isChangeFilter?: boolean,
) => HTMLCanvasElement | undefined;

export const glFilter: {
  applyChromaKey: FilterFn;
  applyBlur: FilterFn;
  applyRadialBlur: FilterFn;
} = {
  applyChromaKey(ctx, video, videoElement, w, h, scaleX, scaleY, scaleW, scaleH, isChangeFilter) {
    const v = video as any;
    if (!v.glCanvas || isChangeFilter) {
      v.glCanvas = document.createElement("canvas");
      v.glCanvas.width = w;
      v.glCanvas.height = h;
      v.gl = v.glCanvas.getContext("webgl", {
        preserveDrawingBuffer: true,
        alpha: true,
      });
      if (!v.gl) {
        console.error("WebGL을 지원하지 않습니다.");
        ctx.drawImage(v.object, scaleX, scaleY, scaleW, scaleH);
        return;
      }
      const gl = v.gl;

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

      const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
      const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
      const program = gl.createProgram();
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error("R:", gl.getProgramInfoLog(program));
        return;
      }
      gl.useProgram(program);
      v.glProgram = program;

      const positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      const positions = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
      const a_position = gl.getAttribLocation(program, "a_position");
      gl.enableVertexAttribArray(a_position);
      gl.vertexAttribPointer(a_position, 2, gl.FLOAT, false, 0, 0);

      const texCoordBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      const texCoords = new Float32Array([0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0]);
      gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
      const a_texCoord = gl.getAttribLocation(program, "a_texCoord");
      gl.enableVertexAttribArray(a_texCoord);
      gl.vertexAttribPointer(a_texCoord, 2, gl.FLOAT, false, 0, 0);

      const videoTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, videoTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      v.glTexture = videoTexture;

      const u_keyColor = gl.getUniformLocation(program, "u_keyColor");
      const u_threshold = gl.getUniformLocation(program, "u_threshold");
      let keyColor = [0.0, 1.0, 0.0];
      let thresholdForce = 0.5;
      if (videoElement.filter.list && videoElement.filter.list.length > 0) {
        const parsed = parseRGBString(videoElement.filter.list[0].value);
        keyColor = [parsed.r / 255, parsed.g / 255, parsed.b / 255];
        thresholdForce = parsed.f;
      }
      gl.uniform3fv(u_keyColor, keyColor);
      gl.uniform1f(u_threshold, thresholdForce);
      const u_video = gl.getUniformLocation(program, "u_video");
      gl.uniform1i(u_video, 0);
    }

    const gl = v.gl;
    const glCanvas = v.glCanvas;
    gl.bindTexture(gl.TEXTURE_2D, v.glTexture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v.object);
    } catch (e) {}
    gl.viewport(0, 0, glCanvas.width, glCanvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return glCanvas;
  },

  applyBlur(ctx, video, videoElement, w, h, scaleX, scaleY, scaleW, scaleH, isChangeFilter) {
    const v = video as any;
    if (!v.glCanvas || isChangeFilter) {
      v.glCanvas = document.createElement("canvas");
      v.glCanvas.width = w;
      v.glCanvas.height = h;
      v.gl = v.glCanvas.getContext("webgl", { preserveDrawingBuffer: true, alpha: true });
      if (!v.gl) {
        console.error("WebGL을 지원하지 않습니다.");
        ctx.drawImage(v.object, scaleX, scaleY, scaleW, scaleH);
        return;
      }
      const gl = v.gl;
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
        uniform vec2 u_texelSize;
        uniform float u_blurFactor;
        varying vec2 v_texCoord;
        void main() {
          vec4 sum = vec4(0.0);
          for (int i = -1; i <= 1; i++) {
            for (int j = -1; j <= 1; j++) {
              vec2 offset = vec2(float(i), float(j)) * u_texelSize * u_blurFactor;
              sum += texture2D(u_video, v_texCoord + offset);
            }
          }
          gl_FragColor = sum / 9.0;
        }
      `;
      const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
      const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
      const program = gl.createProgram();
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error("셰이더 링크 에러:", gl.getProgramInfoLog(program));
        return;
      }
      gl.useProgram(program);
      v.glProgram = program;

      const positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      const positions = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
      const a_position = gl.getAttribLocation(program, "a_position");
      gl.enableVertexAttribArray(a_position);
      gl.vertexAttribPointer(a_position, 2, gl.FLOAT, false, 0, 0);

      const texCoordBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      const texCoords = new Float32Array([0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0]);
      gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
      const a_texCoord = gl.getAttribLocation(program, "a_texCoord");
      gl.enableVertexAttribArray(a_texCoord);
      gl.vertexAttribPointer(a_texCoord, 2, gl.FLOAT, false, 0, 0);

      const videoTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      v.glTexture = videoTexture;

      const u_texelSize = gl.getUniformLocation(program, "u_texelSize");
      gl.uniform2fv(u_texelSize, [1.0 / w, 1.0 / h]);
      const blurFactor = parseBlurString(videoElement.filter.list[0].value);
      const u_blurFactor = gl.getUniformLocation(program, "u_blurFactor");
      gl.uniform1f(u_blurFactor, blurFactor.f);
      const u_video = gl.getUniformLocation(program, "u_video");
      gl.uniform1i(u_video, 0);
    }

    const gl = v.gl;
    const glCanvas = v.glCanvas;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, v.glTexture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v.object);
    } catch (e) {
      console.error("텍스처 업데이트 오류:", e);
    }
    gl.viewport(0, 0, glCanvas.width, glCanvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return glCanvas;
  },

  applyRadialBlur(ctx, video, videoElement, w, h, scaleX, scaleY, scaleW, scaleH, isChangeFilter) {
    const v = video as any;
    if (!v.glCanvas || isChangeFilter) {
      v.glCanvas = document.createElement("canvas");
      v.glCanvas.width = w;
      v.glCanvas.height = h;
      v.gl = v.glCanvas.getContext("webgl", { preserveDrawingBuffer: true, alpha: true });
      if (!v.gl) {
        ctx.drawImage(v.object, scaleX, scaleY, scaleW, scaleH);
        return;
      }
      const gl = v.gl;
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
      uniform float u_power;
      uniform vec2 u_mouse;
      varying vec2 v_texCoord;
      const int samples = 66;
      mat2 rotate2d(float angle) {
        float s = sin(angle);
        float c = cos(angle);
        return mat2(c, -s, s, c);
      }
      vec4 sample(vec2 uv) {
        return texture2D(u_video, uv);
      }
      vec4 frag(vec2 uv) {
        float rotateDir = sin(length(uv - u_mouse) / (0.005 + u_power * 5.0));
        rotateDir = smoothstep(-0.3, 0.3, rotateDir) - 0.5;
        vec2 shiftDir = (uv - u_mouse) * vec2(-1.0, -1.0);
        vec4 color = vec4(0.0);
        for (int i = 0; i < samples; i++) {
          uv += float(i) / float(samples) * shiftDir * 0.01;
          uv -= u_mouse;
          uv *= rotate2d(rotateDir * u_power * float(i));
          uv += u_mouse;
          color += sample(uv) / float(samples + i);
        }
        return color * 1.5;
      }
      void main() {
        gl_FragColor = frag(v_texCoord);
      }
    `;
      const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
      const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
      const program = gl.createProgram();
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error("셰이더 링크 에러:", gl.getProgramInfoLog(program));
        return;
      }
      gl.useProgram(program);
      v.glProgram = program;

      const positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      const positions = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
      const a_position = gl.getAttribLocation(program, "a_position");
      gl.enableVertexAttribArray(a_position);
      gl.vertexAttribPointer(a_position, 2, gl.FLOAT, false, 0, 0);

      const texCoordBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      const texCoords = new Float32Array([0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0]);
      gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
      const a_texCoord = gl.getAttribLocation(program, "a_texCoord");
      gl.enableVertexAttribArray(a_texCoord);
      gl.vertexAttribPointer(a_texCoord, 2, gl.FLOAT, false, 0, 0);

      const videoTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      v.glTexture = videoTexture;

      const u_video = gl.getUniformLocation(program, "u_video");
      gl.uniform1i(u_video, 0);
      const blurFactor = parseBlurString(videoElement.filter.list[0].value);
      const u_power = gl.getUniformLocation(program, "u_power");
      gl.uniform1f(u_power, blurFactor.f);
      const u_mouse = gl.getUniformLocation(program, "u_mouse");
      gl.uniform2fv(u_mouse, [0.5, 0.5]);
    }

    const gl = v.gl;
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v.object);
    } catch (e) {
      console.error("텍스처 업데이트 오류:", e);
    }
    gl.viewport(0, 0, v.glCanvas.width, v.glCanvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return v.glCanvas;
  },
};

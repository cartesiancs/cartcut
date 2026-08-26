/**
 * GL programs for presets: one input for an effect, two for a transition.
 *
 * `BaseQuadFilter` cannot serve either. Its `prepareDraw` hard-codes
 * `uniform1i(u_sampler, 0)` — one texture on one unit — and its attribute names
 * are fixed to `a_position`/`a_texCoord`, where the `gl-transitions` contract
 * uses a single `_p`. Rather than parameterise that class until it fits both,
 * these are siblings: they share `BaseFilter`'s compile-and-link and nothing
 * else.
 *
 * `FxProgram` also differs from the existing filters in a way that matters at
 * run time: a preset's shader arrives from disk and may not compile. A filter's
 * source is a template literal in this repo and a compile failure is a bug, so
 * `BaseFilter` logs and leaves `program` unassigned. Here it is expected — a
 * third-party preset is untrusted content — so failure is a first-class state,
 * `ok` is false, and the compositor draws a pass-through instead of throwing
 * halfway through a frame.
 */

import { createTextureNPOT } from "../gl/texture";

function compile(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): { shader: WebGLShader | null; log: string } {
  const shader = gl.createShader(type);
  if (shader == null) {
    return { shader: null, log: "could not create shader" };
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown compile error";
    gl.deleteShader(shader);
    return { shader: null, log };
  }
  return { shader, log: "" };
}

/** Vertices and, for a mesh, the index buffer that draws them. */
export type Geometry = {
  /** Clip-space positions, two floats per vertex. */
  positions: Float32Array;
  /** Triangle indices, or `null` to draw the positions in order. */
  indices: Uint16Array | null;
  /** Whether drawing this needs a depth buffer. */
  needsDepth: boolean;
};

/** The full-screen quad every 2D preset draws on. */
export function quadGeometry(): Geometry {
  return {
    positions: new Float32Array([
      -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1,
    ]),
    indices: null,
    needsDepth: false,
  };
}

/**
 * A subdivided quad, for presets that bend it.
 *
 * The escape hatch a page curl needs: a fragment shader can only move pixels
 * within the quad it is given, so anything that folds geometry needs actual
 * vertices to fold. Positions are clip-space; the vertex shader derives `_uv`
 * from them exactly as the flat one does, so a grid preset samples in the same
 * space as every other.
 */
export function gridGeometry(cols: number, rows: number): Geometry {
  const positions: number[] = [];
  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x <= cols; x++) {
      positions.push((x / cols) * 2 - 1, (y / rows) * 2 - 1);
    }
  }

  const indices: number[] = [];
  const stride = cols + 1;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const a = y * stride + x;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint16Array(indices),
    // A bent grid can fold back over itself, so the nearer fragment has to win.
    needsDepth: true,
  };
}

/** How far the second face is displaced along x. See `cubeGeometry`. */
export const CUBE_FACE_OFFSET = 4;

/**
 * Two faces, for rotation transitions.
 *
 * Only two are emitted: a cube turning between clips never reveals the other
 * four, and drawing them would need four more textures nobody has.
 *
 * The awkward part is telling them apart. `_p` is the only attribute a preset's
 * vertex shader gets, and two identical quads are indistinguishable inside it —
 * so the second face is emitted **displaced by `CUBE_FACE_OFFSET` along x**, far
 * outside the first face's range, and the vertex shader recovers both the face
 * index and the original coordinate from it:
 *
 * ```glsl
 * float face = step(2.0, _p.x);           // 0 = from, 1 = to
 * vec2 corner = vec2(_p.x - face * 4.0, _p.y);   // back to -1..1
 * ```
 *
 * Which is why these positions are *authoring* space rather than clip space: a
 * mesh preset's vertex shader builds `gl_Position` itself, so the attribute is
 * only ever the data it starts from.
 */
export function cubeGeometry(): Geometry {
  const face = [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1];
  const positions = new Float32Array(face.length * 2);
  positions.set(face, 0);
  for (let i = 0; i < face.length; i += 2) {
    positions[face.length + i] = face[i] + CUBE_FACE_OFFSET;
    positions[face.length + i + 1] = face[i + 1];
  }
  return { positions, indices: null, needsDepth: true };
}

export type FxProgramInput = {
  vertexSource: string;
  fragmentSource: string;
  geometry: Geometry;
  /** Sampler names, bound to texture units in the order given. */
  samplers: string[];
  /** Attribute holding clip-space position. `_p` in the upstream contract. */
  positionAttribute?: string;
};

/**
 * One compiled preset program, with its geometry and sampler bindings.
 *
 * Construction never throws. `ok` says whether the program linked; when it did
 * not, `log` carries the shader error for a toast and the compositor renders a
 * pass-through. A preset is downloadable content, and a bad one must not be
 * able to take down an export at frame 4,000.
 */
export class FxProgram {
  readonly ok: boolean;
  readonly log: string;

  private program: WebGLProgram | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private positionLocation = -1;
  private uniformCache = new Map<string, WebGLUniformLocation | null>();

  readonly vertexCount: number;
  readonly indexCount: number;
  readonly needsDepth: boolean;

  constructor(
    private gl: WebGLRenderingContext,
    private input: FxProgramInput,
  ) {
    const { geometry } = input;
    this.vertexCount = geometry.positions.length / 2;
    this.indexCount = geometry.indices?.length ?? 0;
    this.needsDepth = geometry.needsDepth;

    const vertex = compile(gl, gl.VERTEX_SHADER, input.vertexSource);
    if (vertex.shader == null) {
      this.ok = false;
      this.log = "vertex shader: " + vertex.log;
      return;
    }

    const fragment = compile(gl, gl.FRAGMENT_SHADER, input.fragmentSource);
    if (fragment.shader == null) {
      gl.deleteShader(vertex.shader);
      this.ok = false;
      this.log = "fragment shader: " + fragment.log;
      return;
    }

    const program = gl.createProgram();
    if (program == null) {
      this.ok = false;
      this.log = "could not create program";
      return;
    }

    gl.attachShader(program, vertex.shader);
    gl.attachShader(program, fragment.shader);
    gl.linkProgram(program);
    // The shaders are attached to the program and no longer needed on their
    // own. Without this every preset leaks two shader objects for the life of
    // the context.
    gl.deleteShader(vertex.shader);
    gl.deleteShader(fragment.shader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? "unknown link error";
      gl.deleteProgram(program);
      this.ok = false;
      this.log = "link: " + log;
      return;
    }

    this.program = program;
    this.positionLocation = gl.getAttribLocation(
      program,
      input.positionAttribute ?? "_p",
    );

    this.positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.positions, gl.STATIC_DRAW);

    if (geometry.indices != null) {
      this.indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.bufferData(
        gl.ELEMENT_ARRAY_BUFFER,
        geometry.indices,
        gl.STATIC_DRAW,
      );
    }

    this.ok = true;
    this.log = "";
  }

  /**
   * A uniform's location, looked up once.
   *
   * `getUniformLocation` is a synchronous driver call, and a shader with a
   * dozen parameters would make a dozen of them per frame per clip. `null` is
   * cached too — an unused uniform is optimised out by the compiler, so a miss
   * is normal rather than an error, and re-asking every frame would be the
   * expensive way to learn the same thing.
   */
  uniform(name: string): WebGLUniformLocation | null {
    if (this.uniformCache.has(name)) {
      return this.uniformCache.get(name) ?? null;
    }
    const location =
      this.program == null
        ? null
        : this.gl.getUniformLocation(this.program, name);
    this.uniformCache.set(name, location);
    return location;
  }

  /** Bind the program, its geometry, and its textures to their units. */
  bind(textures: Array<WebGLTexture | null>): void {
    const gl = this.gl;
    if (this.program == null) {
      return;
    }

    gl.useProgram(this.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    if (this.positionLocation >= 0) {
      gl.enableVertexAttribArray(this.positionLocation);
      gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);
    }

    if (this.indexBuffer != null) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    }

    this.input.samplers.forEach((name, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, textures[unit] ?? null);
      gl.uniform1i(this.uniform(name), unit);
    });
  }

  draw(): void {
    const gl = this.gl;
    if (this.program == null) {
      return;
    }
    if (this.indexBuffer != null) {
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    }
  }

  dispose(): void {
    const gl = this.gl;
    if (this.positionBuffer != null) gl.deleteBuffer(this.positionBuffer);
    if (this.indexBuffer != null) gl.deleteBuffer(this.indexBuffer);
    if (this.program != null) gl.deleteProgram(this.program);
    this.program = null;
    this.uniformCache.clear();
  }
}

/**
 * A colour target with an optional depth buffer.
 *
 * `gl/texture.ts#drawToTexture` attaches only `COLOR_ATTACHMENT0`, which is all
 * the existing ping-pong filters need — they are full-screen quads with nothing
 * to occlude. A mesh transition has geometry that folds over itself, and
 * without a depth attachment the far side of a page curl draws over the near
 * side depending only on triangle order.
 */
export class RenderTarget {
  readonly texture: WebGLTexture;
  private framebuffer: WebGLFramebuffer | null;
  private depth: WebGLRenderbuffer | null = null;
  private width = 0;
  private height = 0;

  constructor(
    private gl: WebGLRenderingContext,
    private withDepth: boolean,
  ) {
    this.texture = createTextureNPOT(gl);
    this.framebuffer = gl.createFramebuffer();
  }

  /** Size the colour texture and, if asked for, the depth buffer. */
  resize(width: number, height: number): void {
    if (this.width === width && this.height === height) {
      return;
    }
    const gl = this.gl;

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.bindTexture(gl.TEXTURE_2D, null);

    if (this.withDepth) {
      if (this.depth == null) {
        this.depth = gl.createRenderbuffer();
      }
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
      gl.renderbufferStorage(
        gl.RENDERBUFFER,
        gl.DEPTH_COMPONENT16,
        width,
        height,
      );
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    }

    this.width = width;
    this.height = height;
  }

  /** Run `draw` with this target bound. Always unbinds, even on a throw. */
  use(width: number, height: number, draw: () => void): void {
    const gl = this.gl;
    this.resize(width, height);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.texture,
      0,
    );
    if (this.withDepth && this.depth != null) {
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_ATTACHMENT,
        gl.RENDERBUFFER,
        this.depth,
      );
    }

    gl.viewport(0, 0, width, height);
    try {
      draw();
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  dispose(): void {
    const gl = this.gl;
    if (this.framebuffer != null) gl.deleteFramebuffer(this.framebuffer);
    if (this.depth != null) gl.deleteRenderbuffer(this.depth);
    gl.deleteTexture(this.texture);
    this.framebuffer = null;
    this.depth = null;
  }
}

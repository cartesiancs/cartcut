function createShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (shader == null) {
    console.error("셰이더 생성 에러");
    return null;
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("셰이더 컴파일 에러:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function mustCreateBuffer(gl: WebGLRenderingContext): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (buffer == null) {
    throw new Error("WebGL: failed to create buffer");
  }
  return buffer;
}

export abstract class BaseFilter<TParam> {
  protected program!: WebGLProgram;

  constructor(
    protected gl: WebGLRenderingContext,
    protected vertexShaderSource: string,
    protected fragmentShaderSource: string,
  ) {
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(
      gl,
      gl.FRAGMENT_SHADER,
      fragmentShaderSource,
    );

    if (vertexShader == null || fragmentShader == null) {
      console.error("셰이더 생성 에러");
      return;
    }

    const program = gl.createProgram();
    // Only null on context loss / OOM. `program` is declared with a definite
    // assignment, so a silent undefined here would surface as a confusing
    // failure inside the first draw call instead.
    if (program == null) {
      throw new Error("WebGL: failed to create program");
    }

    this.program = program;
    gl.attachShader(this.program, vertexShader);
    gl.attachShader(this.program, fragmentShader);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      console.error("R:", gl.getProgramInfoLog(this.program));
      return;
    }
  }

  abstract draw(data: TParam, targetTexture: WebGLTexture): void;
}

export class BaseQuadFilter<TParam> extends BaseFilter<TParam> {
  positions = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
  positionBuffer: WebGLBuffer;
  a_position: number;

  texCoordBuffer: WebGLBuffer;
  texCoords = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
  a_texCoord: number;
  u_sampler: WebGLUniformLocation | null = null;

  constructor(
    gl: WebGLRenderingContext,
    vertexShaderSource: string,
    fragmentShaderSource: string,
    protected samplerUniformName: string = "u_sampler",
    protected positionAttribName: string = "a_position",
    protected texCoordAttribName: string = "a_texCoord",
  ) {
    super(gl, vertexShaderSource, fragmentShaderSource);
    this.positionBuffer = mustCreateBuffer(gl);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.positions, gl.STATIC_DRAW);

    this.a_position = gl.getAttribLocation(this.program, positionAttribName);
    this.a_texCoord = gl.getAttribLocation(this.program, texCoordAttribName);

    this.texCoordBuffer = mustCreateBuffer(gl);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.texCoords, gl.STATIC_DRAW);

    this.u_sampler = gl.getUniformLocation(
      this.program,
      this.samplerUniformName,
    );
  }

  prepareDraw(targetTexture: WebGLTexture): void {
    const gl = this.gl;

    gl.useProgram(this.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(this.a_position);
    gl.vertexAttribPointer(this.a_position, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
    gl.enableVertexAttribArray(this.a_texCoord);
    gl.vertexAttribPointer(this.a_texCoord, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targetTexture);
    gl.uniform1i(this.u_sampler, 0);
  }

  draw(data: TParam, targetTexture: WebGLTexture): void {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
  }
}

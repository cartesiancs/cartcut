export function createTextureNPOT(gl: WebGLRenderingContext): WebGLTexture {
  const texture = gl.createTexture();
  // Only null when the context is lost or out of memory; there is nothing
  // useful to render after that, so fail loudly instead of further down.
  if (texture == null) {
    throw new Error("WebGL: failed to create texture");
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return texture;
}

export function drawToTexture(
  gl: WebGLRenderingContext,
  framebuffer: WebGLFramebuffer,
  texture: WebGLTexture,
  width: number,
  height: number,
  drawCallback: () => void,
) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0,
  );

  gl.viewport(0, 0, width, height);
  drawCallback();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/**
 * The only place effects and transitions touch WebGL.
 *
 * ## Its own context, deliberately
 *
 * `loadedAssetStore.videoFilterCanvasCtx` is the app's single WebGL context and
 * this does not share it. That context is resized to each *source video's*
 * native resolution, per clip, per frame — and assigning any canvas dimension
 * reallocates and clears the drawing buffer even when the value is identical
 * (`videoPipeline.ts` guards against exactly that). A compositor working at
 * project resolution would fight it every frame, and each side would wipe the
 * other's buffer on the way past.
 *
 * ## Scratch canvases
 *
 * A shader effect reads the pixels already drawn beneath it. That only works if
 * they were drawn at project resolution with an identity transform, and the
 * preview's target is neither — it is device-sized and carries the viewport's
 * pan and zoom. So when the plan says a shader effect is active, the whole
 * frame is composited into `scratchCtx` first and blitted once at the end.
 * `planFrame` makes that decision before the first pixel, because it cannot be
 * made halfway through.
 *
 * A transition needs no scratch: it renders its two clips into buffers of its
 * own and hands back a finished image, which `drawImage` then places through
 * whatever transform the target happens to carry.
 *
 * ## Failure is a normal state
 *
 * Presets are downloadable content. A shader that does not compile, a texture
 * that will not decode, a context that is lost mid-export — none of these may
 * throw out of a paint loop that is 4,000 frames into a render. Every path here
 * degrades to a pass-through and reports once.
 */

import type { FxPreset, FxParamValues } from "../../fx/presetTypes";
import {
  colorToVec3,
  entryPointOf,
  uniformValueOf,
  vertexShaderFor,
  wrapFragmentShader,
} from "../../fx/glslWrap";
import type { ActiveEffect, ActiveTransition } from "./planFrame";
import {
  FxProgram,
  RenderTarget,
  cubeGeometry,
  gridGeometry,
  quadGeometry,
  type Geometry,
} from "./programs";

/** Draw one element, alone, into a context. Supplied by the paint loop. */
export type DrawOne = (
  ctx: CanvasRenderingContext2D,
  elementId: string,
) => void;

export type CompositorOptions = {
  /**
   * Wait for the GPU before returning.
   *
   * Export reads the 2D canvas back with `getImageData` immediately after the
   * frame is composited, and that read must see the GL result. The preview does
   * not care and should not pay for the stall — the same split
   * `renderVideoWithWait` and `renderVideoWithoutWait` already make.
   */
  blocking?: boolean;
};

const PASSTHROUGH_VERTEX = [
  "attribute vec2 _p;",
  "varying vec2 _uv;",
  "void main() {",
  "  gl_Position = vec4(_p, 0.0, 1.0);",
  "  _uv = vec2(0.5, 0.5) * (_p + vec2(1.0, 1.0));",
  "}",
].join("\n");

function geometryFor(preset: FxPreset): Geometry {
  if (preset.render.type !== "shader" || preset.render.mesh == null) {
    return quadGeometry();
  }
  const mesh = preset.render.mesh;
  if (mesh.kind === "grid") {
    return gridGeometry(mesh.cols, mesh.rows);
  }
  if (mesh.kind === "cube") {
    return cubeGeometry();
  }
  return quadGeometry();
}

export class FxCompositor {
  private programs = new Map<string, FxProgram>();
  private textures = new Map<string, WebGLTexture | null>();
  private reported = new Set<string>();

  private frameTexture: WebGLTexture | null = null;
  private fromTarget: RenderTarget;
  private toTarget: RenderTarget;
  private outputTarget: RenderTarget;

  private scratch: HTMLCanvasElement | null = null;
  private clipA: HTMLCanvasElement | null = null;
  private clipB: HTMLCanvasElement | null = null;

  constructor(
    private gl: WebGLRenderingContext,
    private options: CompositorOptions = {},
  ) {
    this.fromTarget = new RenderTarget(gl, false);
    this.toTarget = new RenderTarget(gl, false);
    this.outputTarget = new RenderTarget(gl, true);
  }

  // ---------------------------------------------------------------- canvases

  private canvas(
    which: "scratch" | "clipA" | "clipB",
    width: number,
    height: number,
  ): HTMLCanvasElement {
    let canvas = this[which];
    if (canvas == null) {
      canvas = document.createElement("canvas");
      this[which] = canvas;
    }
    // Assigning a dimension reallocates and clears, so only do it on a change.
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    return canvas;
  }

  /**
   * A cleared, project-resolution 2D context to composite the frame into.
   *
   * Identity transform, unlike the preview's target — which is the entire
   * reason it exists.
   */
  scratchCtx(width: number, height: number): CanvasRenderingContext2D | null {
    const canvas = this.canvas("scratch", width, height);
    const ctx = canvas.getContext("2d");
    if (ctx == null) {
      return null;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, width, height);
    return ctx;
  }

  /** Put a finished scratch frame onto the real target. */
  flushScratch(
    target: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): void {
    if (this.scratch == null) {
      return;
    }
    target.drawImage(this.scratch, 0, 0, width, height);
  }

  // ----------------------------------------------------------------- programs

  /**
   * The compiled program for a preset, built once and kept.
   *
   * Keyed by preset id, so switching a clip between presets and back does not
   * recompile. A failed compile is cached too — retrying a broken shader every
   * frame would spend the whole frame budget in the driver.
   */
  private programFor(preset: FxPreset): FxProgram | null {
    const cached = this.programs.get(preset.id);
    if (cached != null) {
      return cached.ok ? cached : null;
    }
    if (preset.render.type !== "shader") {
      return null;
    }

    const textureUniforms = (preset.render.textures ?? []).map(
      (texture) => texture.uniform,
    );
    const fragment = wrapFragmentShader({
      kind: preset.kind,
      source: preset.sources[preset.render.source] ?? "",
      textureUniforms,
    });
    const vertex = vertexShaderFor(
      preset.kind,
      preset.render.vertex != null
        ? preset.sources[preset.render.vertex]
        : undefined,
    );

    const samplers =
      preset.kind === "transition"
        ? ["from", "to", ...textureUniforms]
        : ["source", ...textureUniforms];

    const program = new FxProgram(this.gl, {
      vertexSource: vertex,
      fragmentSource: fragment,
      geometry: geometryFor(preset),
      samplers,
    });

    this.programs.set(preset.id, program);

    if (!program.ok) {
      this.reportOnce(
        preset.id,
        "preset `" +
          preset.id +
          "` did not compile and will render as a pass-through.\n" +
          program.log +
          "\nEntry point expected: vec4 " +
          entryPointOf(preset.kind) +
          "(vec2 uv)",
      );
      return null;
    }
    return program;
  }

  private reportOnce(key: string, message: string): void {
    if (this.reported.has(key)) {
      return;
    }
    this.reported.add(key);
    console.error(message);
  }

  /**
   * A preset's shipped texture, uploaded once.
   *
   * Images load asynchronously, so the first frames after a preset appears draw
   * with an unbound sampler. That reads as transparent black rather than as an
   * error, and the next repaint has the real thing — the same shape of
   * behaviour `loadedAssetStore` has for a video that has not decoded yet.
   */
  private textureFor(preset: FxPreset, relativePath: string): WebGLTexture | null {
    const key = preset.id + "|" + relativePath;
    if (this.textures.has(key)) {
      return this.textures.get(key) ?? null;
    }
    this.textures.set(key, null);

    const source = preset.assets[relativePath];
    if (source == null) {
      return null;
    }

    const gl = this.gl;
    const image = new Image();
    image.onload = () => {
      try {
        const texture = gl.createTexture();
        if (texture == null) return;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          image,
        );
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.bindTexture(gl.TEXTURE_2D, null);
        this.textures.set(key, texture);
      } catch (error) {
        this.reportOnce(key, "preset texture failed to upload: " + String(error));
      }
    };
    image.onerror = () => {
      this.reportOnce(key, "preset texture could not be read: " + relativePath);
    };
    image.src = "file://" + source;

    return null;
  }

  /** Write every parameter the preset declared into its uniforms. */
  private applyParams(
    program: FxProgram,
    preset: FxPreset,
    values: FxParamValues,
  ): void {
    const gl = this.gl;
    for (const param of preset.params) {
      const location = program.uniform(param.uniform);
      if (location == null) {
        // Declared but unused, so the compiler removed it. Not an error.
        continue;
      }
      const value = uniformValueOf(param, values[param.key]);
      if (Array.isArray(value)) {
        if (value.length === 2) {
          gl.uniform2f(location, value[0], value[1]);
        } else {
          gl.uniform3f(location, value[0], value[1], value[2]);
        }
      } else {
        gl.uniform1f(location, value);
      }
    }
  }

  private bindPresetTextures(
    preset: FxPreset,
    leading: Array<WebGLTexture | null>,
  ): Array<WebGLTexture | null> {
    const extra =
      preset.render.type === "shader"
        ? (preset.render.textures ?? []).map((texture) =>
            this.textureFor(preset, texture.source),
          )
        : [];
    return [...leading, ...extra];
  }

  /**
   * Upload a 2D canvas into `frameTexture`, reusing the allocation.
   *
   * `TexImageSource` rather than `CanvasImageSource`: the latter includes
   * `SVGImageElement`, which WebGL cannot sample. Both callers hand over a
   * canvas, so the narrower type costs nothing and states the real contract.
   */
  private uploadFrame(source: TexImageSource): WebGLTexture | null {
    const gl = this.gl;
    if (this.frameTexture == null) {
      this.frameTexture = gl.createTexture();
      if (this.frameTexture == null) {
        return null;
      }
      gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    return this.frameTexture;
  }

  private sizeGlCanvas(width: number, height: number): void {
    const canvas = this.gl.canvas as HTMLCanvasElement;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  }

  // ------------------------------------------------------------------ effects

  /**
   * Run an effect over everything drawn so far.
   *
   * An overlay is a Canvas2D composite against what is already there — which is
   * precisely adjustment-layer semantics, for free, with no GL round trip. A
   * shader has to read the target back, which is why `planFrame` insisted the
   * frame be composited into a project-resolution scratch canvas first.
   */
  applyEffect(
    target: CanvasRenderingContext2D,
    active: ActiveEffect,
    preset: FxPreset,
    width: number,
    height: number,
    overlayFrame: CanvasImageSource | null,
  ): void {
    if (active.mode === "overlay") {
      if (overlayFrame == null) {
        return;
      }
      target.save();
      target.globalCompositeOperation =
        (active.element.blend as GlobalCompositeOperation) ??
        (preset.render.type === "overlay"
          ? ((preset.render.blend as GlobalCompositeOperation) ?? "screen")
          : "screen");
      target.globalAlpha = Math.max(
        0,
        Math.min(1, active.element.intensity / 100),
      );
      target.drawImage(overlayFrame, 0, 0, width, height);
      target.restore();
      return;
    }

    const program = this.programFor(preset);
    if (program == null) {
      return;
    }

    const gl = this.gl;
    this.sizeGlCanvas(width, height);

    const frame = this.uploadFrame(target.canvas);
    if (frame == null) {
      return;
    }

    this.outputTarget.use(width, height, () => {
      gl.disable(gl.DEPTH_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      program.bind(this.bindPresetTextures(preset, [frame]));
      gl.uniform1f(
        program.uniform("intensity"),
        Math.max(0, Math.min(1, active.element.intensity / 100)),
      );
      gl.uniform2f(program.uniform("resolution"), width, height);
      this.applyParams(program, preset, active.element.params);
      program.draw();
    });

    this.blitTargetTo(target, this.outputTarget, width, height, "copy");
  }

  // -------------------------------------------------------------- transitions

  /**
   * Render both clips and mix them.
   *
   * The two clips are drawn into separate project-resolution 2D canvases —
   * through the ordinary `renderElement` path, so their own transforms,
   * opacity, keyframes and parenting all apply exactly as they would without a
   * transition. **Nothing here writes a keyframe.** The shader then samples two
   * finished pictures, which is why a slide composes with a clip that was
   * already animating its position instead of fighting it.
   */
  drawTransition(
    target: CanvasRenderingContext2D,
    active: ActiveTransition,
    preset: FxPreset,
    width: number,
    height: number,
    drawOne: DrawOne,
  ): void {
    const program = this.programFor(preset);
    if (program == null) {
      // No usable shader. Falling back to the outgoing clip alone keeps the cut
      // the user had before they added a transition, which is the least
      // surprising thing a broken preset can do.
      this.drawClipDirect(target, active.fromId, width, height, drawOne);
      return;
    }

    const fromImage = this.renderClip("clipA", active.fromId, width, height, drawOne);
    const toImage = this.renderClip("clipB", active.toId, width, height, drawOne);
    if (fromImage == null || toImage == null) {
      return;
    }

    const gl = this.gl;
    this.sizeGlCanvas(width, height);

    const fromTexture = this.uploadInto(this.fromTarget, fromImage, width, height);
    const toTexture = this.uploadInto(this.toTarget, toImage, width, height);
    if (fromTexture == null || toTexture == null) {
      return;
    }

    this.outputTarget.use(width, height, () => {
      if (program.needsDepth) {
        gl.enable(gl.DEPTH_TEST);
        gl.clear(gl.DEPTH_BUFFER_BIT);
      } else {
        gl.disable(gl.DEPTH_TEST);
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      program.bind(
        this.bindPresetTextures(preset, [fromTexture, toTexture]),
      );
      gl.uniform1f(program.uniform("progress"), active.progress);
      // Both clips were drawn into project-resolution buffers, so the aspect
      // corrections `gl-transitions` shaders apply resolve to identity. Passing
      // the real numbers rather than 1.0 keeps a shader that reads `ratio` for
      // its own geometry — several do — behaving as it does upstream.
      const ratio = width / Math.max(height, 1);
      gl.uniform1f(program.uniform("ratio"), ratio);
      gl.uniform1f(program.uniform("_fromR"), ratio);
      gl.uniform1f(program.uniform("_toR"), ratio);
      this.applyParams(program, preset, active.element.params);
      program.draw();
      gl.disable(gl.DEPTH_TEST);
    });

    this.blitTargetTo(target, this.outputTarget, width, height, "source-over");
  }

  /** Draw one clip into a private canvas and return it. */
  private renderClip(
    which: "clipA" | "clipB",
    elementId: string,
    width: number,
    height: number,
    drawOne: DrawOne,
  ): HTMLCanvasElement | null {
    const canvas = this.canvas(which, width, height);
    const ctx = canvas.getContext("2d");
    if (ctx == null) {
      return null;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, width, height);
    drawOne(ctx, elementId);
    return canvas;
  }

  /** The fallback when a transition cannot run: just the outgoing clip. */
  private drawClipDirect(
    target: CanvasRenderingContext2D,
    elementId: string,
    width: number,
    height: number,
    drawOne: DrawOne,
  ): void {
    const canvas = this.renderClip("clipA", elementId, width, height, drawOne);
    if (canvas != null) {
      target.drawImage(canvas, 0, 0, width, height);
    }
  }

  /** Upload a canvas into a target's texture without drawing anything. */
  private uploadInto(
    into: RenderTarget,
    source: TexImageSource,
    width: number,
    height: number,
  ): WebGLTexture | null {
    const gl = this.gl;
    into.resize(width, height);
    gl.bindTexture(gl.TEXTURE_2D, into.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return into.texture;
  }

  /**
   * Move a render target's colour texture onto the 2D canvas.
   *
   * Via the GL canvas rather than `readPixels`: the context is created with
   * `preserveDrawingBuffer`, so a plain quad blit followed by `drawImage` is
   * both simpler and much faster than a CPU round trip.
   */
  private blitTargetTo(
    target: CanvasRenderingContext2D,
    from: RenderTarget,
    width: number,
    height: number,
    operation: GlobalCompositeOperation,
  ): void {
    const gl = this.gl;
    const blit = this.blitProgram();
    if (blit == null) {
      return;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    blit.bind([from.texture]);
    blit.draw();

    if (this.options.blocking === true) {
      gl.finish();
    }

    target.save();
    target.globalCompositeOperation = operation;
    target.globalAlpha = 1;
    target.drawImage(gl.canvas as HTMLCanvasElement, 0, 0, width, height);
    target.restore();
  }

  private blit: FxProgram | null = null;

  private blitProgram(): FxProgram | null {
    if (this.blit != null) {
      return this.blit.ok ? this.blit : null;
    }
    this.blit = new FxProgram(this.gl, {
      vertexSource: PASSTHROUGH_VERTEX,
      fragmentSource: [
        "precision highp float;",
        "varying vec2 _uv;",
        "uniform sampler2D source;",
        "void main() { gl_FragColor = texture2D(source, _uv); }",
      ].join("\n"),
      geometry: quadGeometry(),
      samplers: ["source"],
    });
    if (!this.blit.ok) {
      this.reportOnce("blit", "fx: blit program failed: " + this.blit.log);
      return null;
    }
    return this.blit;
  }

  dispose(): void {
    for (const program of this.programs.values()) {
      program.dispose();
    }
    this.programs.clear();
    this.blit?.dispose();
    this.blit = null;

    for (const texture of this.textures.values()) {
      if (texture != null) this.gl.deleteTexture(texture);
    }
    this.textures.clear();

    if (this.frameTexture != null) {
      this.gl.deleteTexture(this.frameTexture);
      this.frameTexture = null;
    }

    this.fromTarget.dispose();
    this.toTarget.dispose();
    this.outputTarget.dispose();
  }
}

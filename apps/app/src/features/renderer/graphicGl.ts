/**
 * Drawing a GLSL graphic: a generator that fills a box from a clock and a size.
 *
 * Its own WebGL context, for the reason the compositor has its own: a context's
 * drawing buffer is sized to its canvas, and two users of one canvas resize it
 * under each other and clear each other's frame. The canvas only grows, and each
 * draw uses the bottom-left `width x height` of it through `gl.viewport`, so a
 * clip animating its size does not reallocate the buffer every frame.
 *
 * Programs are cached the way `FxCompositor.programFor` caches them: by preset
 * id and source, failures included, reported once. An inline program's id is a
 * content hash, so drafts get a bounded cache that disposes what it evicts.
 *
 * Coordinates are GL's: `uv` is 0..1 with y growing upwards, as in every
 * shader on the web this contract borrows from. The result is read back with
 * `drawImage` from the source rectangle `draw` returns.
 */

import { isUniformParam, type FxParamValues, type FxPreset } from "../fx/presetTypes";
import {
  entryPointOf,
  uniformValueOf,
  vertexShaderFor,
  wrapFragmentShader,
} from "../fx/glslWrap";
import { FxProgram, quadGeometry } from "./fx/programs";
import { BoundedCache } from "./lut/boundedCache";

/** The longest side a graphic is rasterised at, before it is scaled down to fit. */
export const MAX_RASTER_SIDE = 4096;

/** And the most pixels in one raster: 4096 x 4096. */
export const MAX_RASTER_PIXELS = 4096 * 4096;

/**
 * The raster size for a box drawn at `scale` device pixels per box pixel,
 * shrunk proportionally to the two caps. Never below 1 x 1.
 */
export function rasterSizeFor(
  width: number,
  height: number,
  scale: number,
): { width: number; height: number } {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  let w = Math.max(1, Math.ceil(Math.abs(width) * s));
  let h = Math.max(1, Math.ceil(Math.abs(height) * s));
  const side = Math.max(w, h);
  if (side > MAX_RASTER_SIDE) {
    const k = MAX_RASTER_SIDE / side;
    w = Math.max(1, Math.floor(w * k));
    h = Math.max(1, Math.floor(h * k));
  }
  if (w * h > MAX_RASTER_PIXELS) {
    const k = Math.sqrt(MAX_RASTER_PIXELS / (w * h));
    w = Math.max(1, Math.floor(w * k));
    h = Math.max(1, Math.floor(h * k));
  }
  return { width: w, height: h };
}

export type GraphicGlTime = {
  seconds: number;
  progress: number;
  durationSeconds: number;
};

export type GraphicRaster = {
  canvas: HTMLCanvasElement;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
};

export class GraphicGl {
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGLRenderingContext | null = null;
  private programs = new Map<string, FxProgram>();
  private inlinePrograms = new BoundedCache<string, FxProgram>(64, (_key, program) =>
    program.dispose(),
  );
  private reported = new Set<string>();
  private failed = false;

  constructor(private options: { blocking: boolean } = { blocking: false }) {}

  private context(): WebGLRenderingContext | null {
    if (this.gl != null || this.failed) {
      return this.gl;
    }
    try {
      this.canvas = document.createElement("canvas");
      this.canvas.width = 1;
      this.canvas.height = 1;
      this.gl = this.canvas.getContext("webgl", {
        preserveDrawingBuffer: true,
        alpha: true,
        premultipliedAlpha: false,
      }) as WebGLRenderingContext | null;
    } catch {
      this.gl = null;
    }
    if (this.gl == null) {
      this.failed = true;
    }
    return this.gl;
  }

  private programFor(preset: FxPreset): FxProgram | null {
    const gl = this.gl;
    if (gl == null || preset.render.type !== "shader") {
      return null;
    }
    const name = preset.render.source;
    const key = preset.id + "|" + name;
    const inline = preset.origin === "inline";
    const cached = inline ? this.inlinePrograms.get(key) : this.programs.get(key);
    if (cached != null) {
      return cached.ok ? cached : null;
    }
    const program = new FxProgram(gl, {
      vertexSource: vertexShaderFor("graphic"),
      fragmentSource: wrapFragmentShader({
        kind: "graphic",
        source: preset.sources[name] ?? "",
      }),
      geometry: quadGeometry(),
      samplers: [],
    });
    if (inline) {
      this.inlinePrograms.set(key, program);
    } else {
      this.programs.set(key, program);
    }
    if (!program.ok) {
      if (!this.reported.has(key)) {
        this.reported.add(key);
        console.error(
          "graphic `" +
            preset.id +
            "` did not compile and draws nothing.\n" +
            program.log +
            "\nEntry point expected: vec4 " +
            entryPointOf("graphic") +
            "(vec2 uv)",
        );
      }
      return null;
    }
    return program;
  }

  /**
   * Draw one frame of a generator at `width x height` pixels, or `null` when
   * there is no GL here or the program does not compile.
   */
  draw(
    preset: FxPreset,
    params: FxParamValues,
    time: GraphicGlTime,
    width: number,
    height: number,
  ): GraphicRaster | null {
    const gl = this.context();
    const canvas = this.canvas;
    if (gl == null || canvas == null) {
      return null;
    }
    const program = this.programFor(preset);
    if (program == null) {
      return null;
    }

    if (canvas.width < width || canvas.height < height) {
      canvas.width = Math.max(canvas.width, width);
      canvas.height = Math.max(canvas.height, height);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);

    program.bind([]);
    gl.uniform1f(program.uniform("time"), time.seconds);
    gl.uniform1f(program.uniform("progress"), time.progress);
    gl.uniform1f(program.uniform("duration"), time.durationSeconds);
    gl.uniform2f(program.uniform("resolution"), width, height);
    for (const param of preset.params) {
      if (!isUniformParam(param)) {
        continue;
      }
      const location = program.uniform(param.uniform);
      if (location == null) {
        continue;
      }
      const value = uniformValueOf(param, params[param.key]);
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
    program.draw();
    if (this.options.blocking) {
      gl.finish();
    }

    // The viewport's origin is GL's bottom-left; in the canvas's own top-left
    // coordinates that region starts `canvas.height - height` down.
    return { canvas, sx: 0, sy: canvas.height - height, sw: width, sh: height };
  }

  dispose(): void {
    for (const program of this.programs.values()) {
      program.dispose();
    }
    this.programs.clear();
    this.inlinePrograms.clear();
    const lose = this.gl?.getExtension("WEBGL_lose_context");
    lose?.loseContext();
    this.gl = null;
    this.canvas = null;
  }
}

/**
 * Grading on the GPU, for the per-clip path.
 *
 * ## Its own context, deliberately
 *
 * Three WebGL contexts already exist in this app and this makes a fourth, which
 * wants justifying. It cannot share either of the others:
 *
 *  - `loadedAssetStore.videoFilterCanvasCtx` is resized to each *source video's*
 *    native resolution, per clip, per frame. This one works at layer resolution.
 *    Assigning any canvas dimension reallocates and clears the drawing buffer
 *    even when the value is identical, so the two would wipe each other's work
 *    every frame — the same argument `fx/compositor.ts` makes at its top.
 *  - The FX compositor's context is mid-frame whenever a clip LUT runs: an
 *    adjustment layer above a graded clip has the compositor's render targets
 *    bound and its viewport set. Borrowing it would corrupt both.
 *
 * ## Precision
 *
 * The atlas is uploaded as **half float** where `OES_texture_half_float` is
 * available, which is everywhere Chromium runs on a desktop. It matters: at
 * `UNSIGNED_BYTE` a node value carries up to 1/510 of error, which is half a
 * step of the 8-bit output, and it puts the GPU and CPU appliers a step apart
 * often enough that the end-to-end determinism comparison notices. Half float
 * carries eleven bits of mantissa and the difference disappears.
 *
 * The byte path is kept as the fallback, and it also *clamps* — an HDR LUT with
 * nodes outside 0-1 loses them there. Stated rather than fixed, because the
 * hosts that lack the extension are the ones where nothing better is possible.
 *
 * ## Failure is a normal state
 *
 * Nothing here throws. A context that will not compile a shader, a texture that
 * will not allocate, a context lost mid-export — each degrades to returning
 * `false`, which draws the clip ungraded. The alternative is an exception four
 * thousand frames into a render.
 */

import { toAtlas, toAtlasBytes, toAtlasHalf, type LutAtlas } from "../../lut/atlas";
import {
  LUT_FRAGMENT_SHADER,
  LUT_UNIFORM,
  LUT_VERTEX_SHADER,
  lutUniformsFor,
} from "../../lut/glsl";
import type { LutData } from "../../lut/lutData";
import { FxProgram, quadGeometry } from "../fx/programs";
import type { Surface } from "../surface";
import { lutBlocking, type LutApplier } from "./apply";

/** `HALF_FLOAT_OES`, which the extension object carries rather than `gl`. */
type HalfFloatExtension = { HALF_FLOAT_OES: number };

type Uploaded = {
  texture: WebGLTexture;
  atlas: LutAtlas;
};

export function createGpuLutApplier(): LutApplier | null {
  if (typeof document === "undefined") {
    return null;
  }

  let gl: WebGLRenderingContext | null = null;
  try {
    const canvas = document.createElement("canvas");
    gl = canvas.getContext("webgl", {
      // The result is read back with `drawImage` after the draw call rather
      // than during it, which is why the buffer has to survive.
      preserveDrawingBuffer: true,
      alpha: true,
      // Straight alpha in and out. `lut/glsl.ts` explains why both flags
      // matter and what breaks if either is flipped.
      premultipliedAlpha: false,
    }) as WebGLRenderingContext | null;
  } catch {
    gl = null;
  }
  if (gl == null) {
    return null;
  }

  const context = gl;
  const halfFloat = context.getExtension(
    "OES_texture_half_float",
  ) as HalfFloatExtension | null;

  let program: FxProgram | null = null;
  let sourceTexture: WebGLTexture | null = null;
  const uploaded = new Map<string, Uploaded | null>();
  let reported = false;

  const reportOnce = (message: string): void => {
    if (reported) {
      return;
    }
    reported = true;
    console.error(message);
  };

  const programOrNull = (): FxProgram | null => {
    if (program != null) {
      return program.ok ? program : null;
    }
    program = new FxProgram(context, {
      vertexSource: LUT_VERTEX_SHADER,
      fragmentSource: LUT_FRAGMENT_SHADER,
      geometry: quadGeometry(),
      // Binding order: unit 0 is the clip, unit 1 is the LUT.
      samplers: ["uSource", LUT_UNIFORM.texture],
    });
    if (!program.ok) {
      reportOnce(`lut: shader did not compile, grading on the CPU instead.\n${program.log}`);
      return null;
    }
    return program;
  };

  /** Upload a LUT once and keep it. Keyed by preset id. */
  const atlasFor = (key: string, lut: LutData): Uploaded | null => {
    if (uploaded.has(key)) {
      return uploaded.get(key) ?? null;
    }
    uploaded.set(key, null);

    const atlas = toAtlas(lut);
    const texture = context.createTexture();
    if (texture == null) {
      return null;
    }
    context.bindTexture(context.TEXTURE_2D, texture);
    // NEAREST, because the shader interpolates itself — see `lut/atlas.ts` on
    // why hardware filtering would bleed across the tile boundaries.
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);

    try {
      if (halfFloat != null) {
        context.texImage2D(
          context.TEXTURE_2D,
          0,
          context.RGBA,
          atlas.width,
          atlas.height,
          0,
          context.RGBA,
          halfFloat.HALF_FLOAT_OES,
          toAtlasHalf(atlas) as unknown as ArrayBufferView,
        );
      } else {
        context.texImage2D(
          context.TEXTURE_2D,
          0,
          context.RGBA,
          atlas.width,
          atlas.height,
          0,
          context.RGBA,
          context.UNSIGNED_BYTE,
          toAtlasBytes(atlas),
        );
      }
    } catch (error) {
      reportOnce(`lut: could not upload the table: ${String(error)}`);
      context.deleteTexture(texture);
      return null;
    }
    context.bindTexture(context.TEXTURE_2D, null);

    const entry = { texture, atlas };
    uploaded.set(key, entry);
    return entry;
  };

  const sourceTextureOrNull = (): WebGLTexture | null => {
    if (sourceTexture == null) {
      sourceTexture = context.createTexture();
      if (sourceTexture == null) {
        return null;
      }
      context.bindTexture(context.TEXTURE_2D, sourceTexture);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    }
    return sourceTexture;
  };

  return {
    apply(surface: Surface, key: string, lut: LutData, amount: number): boolean {
      const width = surface.canvas.width;
      const height = surface.canvas.height;
      if (!(width > 0) || !(height > 0)) {
        return false;
      }

      const shader = programOrNull();
      const table = atlasFor(key, lut);
      const source = sourceTextureOrNull();
      if (shader == null || table == null || source == null) {
        return false;
      }

      const canvas = context.canvas as HTMLCanvasElement;
      // Assigning a dimension reallocates and clears even when unchanged.
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;

      context.bindTexture(context.TEXTURE_2D, source);
      // Flipped, because texture space runs bottom-up and canvas space does
      // not. The quad's `_uv` is unflipped, so the flip happens on upload and
      // the result lands the right way round when it is drawn back.
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, true);
      try {
        context.texImage2D(
          context.TEXTURE_2D,
          0,
          context.RGBA,
          context.RGBA,
          context.UNSIGNED_BYTE,
          surface.canvas as unknown as TexImageSource,
        );
      } catch (error) {
        context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, false);
        reportOnce(`lut: could not read the clip layer: ${String(error)}`);
        return false;
      }
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, false);

      context.bindFramebuffer(context.FRAMEBUFFER, null);
      context.viewport(0, 0, width, height);
      context.disable(context.DEPTH_TEST);
      context.disable(context.BLEND);
      context.clearColor(0, 0, 0, 0);
      context.clear(context.COLOR_BUFFER_BIT);

      shader.bind([source, table.texture]);
      const uniforms = lutUniformsFor(table.atlas);
      context.uniform2f(
        shader.uniform(LUT_UNIFORM.atlasSize),
        uniforms.atlasWidth,
        uniforms.atlasHeight,
      );
      context.uniform1f(shader.uniform(LUT_UNIFORM.size), uniforms.size);
      context.uniform1f(shader.uniform(LUT_UNIFORM.cols), uniforms.cols);
      context.uniform3f(
        shader.uniform(LUT_UNIFORM.domainScale),
        ...uniforms.domainScale,
      );
      context.uniform3f(
        shader.uniform(LUT_UNIFORM.domainOffset),
        ...uniforms.domainOffset,
      );
      context.uniform1f(shader.uniform(LUT_UNIFORM.is1d), uniforms.is1d);
      context.uniform1f(shader.uniform(LUT_UNIFORM.amount), amount);
      shader.draw();

      if (lutBlocking()) {
        context.finish();
      }

      // Replace rather than compose: the layer already held these pixels, and
      // `source-over` would blend the graded copy against the ungraded one and
      // halve every alpha.
      surface.ctx.save();
      surface.ctx.setTransform(1, 0, 0, 1, 0, 0);
      surface.ctx.globalAlpha = 1;
      surface.ctx.globalCompositeOperation = "copy";
      surface.ctx.drawImage(canvas, 0, 0, width, height);
      surface.ctx.restore();
      return true;
    },

    dispose(): void {
      program?.dispose();
      program = null;
      for (const entry of uploaded.values()) {
        if (entry != null) {
          context.deleteTexture(entry.texture);
        }
      }
      uploaded.clear();
      if (sourceTexture != null) {
        context.deleteTexture(sourceTexture);
        sourceTexture = null;
      }
    },
  };
}

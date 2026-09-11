/**
 * The finishing adjustments on the GPU.
 *
 * Its own WebGL context, for the reasons `lut/gpu.ts` gives for its own: the
 * video-filter context is resized per source video, and the FX compositor's is
 * mid-frame whenever a clip is drawn beneath an adjustment layer. Borrowing
 * the LUT applier's context would work today and break the day either applier
 * gained a render target the other did not expect to find bound.
 *
 * Up to three passes, and only one unless clarity is on:
 *
 *   1. clarity's horizontal blur, premultiplied layer → target A, as `(L·a, a)`;
 *   2. its vertical blur, A → B;
 *   3. the finish, reading the straight layer, the premultiplied one and B,
 *      into the default framebuffer — blitted back onto the layer with `copy`,
 *      as the LUT applier does.
 *
 * The layer is uploaded twice when a stage reads neighbours: straight for the
 * pixel being finished, premultiplied for the blur taps. `glsl.ts` says why.
 *
 * Nothing here throws; any failure answers `false` and the clip is drawn
 * without its finish.
 */

import { FxProgram, RenderTarget, quadGeometry } from "../fx/programs";
import { lutBlocking } from "../lut/apply";
import type { Surface } from "../surface";
import type { FinishApplier, FinishRender } from "./apply";
import {
  BLUR_FRAGMENT_SHADER,
  BLUR_UNIFORM,
  FINISH_FRAGMENT_SHADER,
  FINISH_UNIFORM,
  FINISH_VERTEX_SHADER,
} from "./glsl";

export function createGpuFinishApplier(): FinishApplier | null {
  if (typeof document === "undefined") {
    return null;
  }

  let gl: WebGLRenderingContext | null = null;
  try {
    const canvas = document.createElement("canvas");
    gl = canvas.getContext("webgl", {
      preserveDrawingBuffer: true,
      alpha: true,
      premultipliedAlpha: false,
    }) as WebGLRenderingContext | null;
  } catch {
    gl = null;
  }
  if (gl == null) {
    return null;
  }
  const context = gl;

  let blurProgram: FxProgram | null = null;
  let finishProgram: FxProgram | null = null;
  let straightTexture: WebGLTexture | null = null;
  let premultTexture: WebGLTexture | null = null;
  let targetA: RenderTarget | null = null;
  let targetB: RenderTarget | null = null;
  let failed = false;
  let reported = false;

  const reportOnce = (message: string): void => {
    if (reported) {
      return;
    }
    reported = true;
    console.error(message);
  };

  const programs = (): { blur: FxProgram; finish: FxProgram } | null => {
    if (failed) {
      return null;
    }
    if (blurProgram == null || finishProgram == null) {
      blurProgram = new FxProgram(context, {
        vertexSource: FINISH_VERTEX_SHADER,
        fragmentSource: BLUR_FRAGMENT_SHADER,
        geometry: quadGeometry(),
        samplers: [BLUR_UNIFORM.source],
      });
      finishProgram = new FxProgram(context, {
        vertexSource: FINISH_VERTEX_SHADER,
        fragmentSource: FINISH_FRAGMENT_SHADER,
        geometry: quadGeometry(),
        // Binding order: 0 straight, 1 premultiplied, 2 clarity's blur.
        samplers: [FINISH_UNIFORM.source, FINISH_UNIFORM.premult, FINISH_UNIFORM.blurred],
      });
      if (!blurProgram.ok || !finishProgram.ok) {
        failed = true;
        reportOnce(
          `adjust: shader did not compile, finishing is off.\n${blurProgram.log}\n${finishProgram.log}`,
        );
        return null;
      }
    }
    return { blur: blurProgram, finish: finishProgram };
  };

  const linearTexture = (): WebGLTexture | null => {
    const texture = context.createTexture();
    if (texture == null) {
      return null;
    }
    context.bindTexture(context.TEXTURE_2D, texture);
    // LINEAR and CLAMP_TO_EDGE: the CPU applier's `sampleLinear` is written
    // against exactly this, and the two must sample alike.
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    return texture;
  };

  /** Upload the layer into `texture`, flipped, straight or premultiplied. */
  const upload = (texture: WebGLTexture, surface: Surface, premultiply: boolean): boolean => {
    context.bindTexture(context.TEXTURE_2D, texture);
    context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, true);
    context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    try {
      context.texImage2D(
        context.TEXTURE_2D,
        0,
        context.RGBA,
        context.RGBA,
        context.UNSIGNED_BYTE,
        surface.canvas as unknown as TexImageSource,
      );
      return true;
    } catch (error) {
      reportOnce(`adjust: could not read the clip layer: ${String(error)}`);
      return false;
    } finally {
      // Both back to their defaults: the straight upload depends on
      // premultiply being off, and nothing else here expects a flip.
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, false);
      context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
  };

  const blurInto = (
    program: FxProgram,
    target: RenderTarget,
    input: WebGLTexture,
    width: number,
    height: number,
    direction: [number, number],
    fromColor: boolean,
  ): void => {
    target.use(width, height, () => {
      context.disable(context.BLEND);
      context.clearColor(0, 0, 0, 0);
      context.clear(context.COLOR_BUFFER_BIT);
      program.bind([input]);
      context.uniform2f(program.uniform(BLUR_UNIFORM.texel), 1 / width, 1 / height);
      context.uniform2f(program.uniform(BLUR_UNIFORM.direction), direction[0], direction[1]);
      context.uniform1f(program.uniform(BLUR_UNIFORM.fromColor), fromColor ? 1 : 0);
      program.draw();
    });
  };

  return {
    apply(surface: Surface, render: FinishRender): boolean {
      const width = surface.canvas.width;
      const height = surface.canvas.height;
      if (!(width > 0) || !(height > 0)) {
        return false;
      }
      const shaders = programs();
      straightTexture ??= linearTexture();
      if (shaders == null || straightTexture == null) {
        return false;
      }

      const canvas = context.canvas as HTMLCanvasElement;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;

      const { amounts } = render;
      if (!upload(straightTexture, surface, false)) {
        return false;
      }

      // The premultiplied view only when a stage reads neighbours; otherwise
      // unit 1 is bound to the straight texture and never sampled.
      let premult: WebGLTexture = straightTexture;
      if (amounts.clarity > 0 || amounts.sharpen > 0) {
        premultTexture ??= linearTexture();
        if (premultTexture == null || !upload(premultTexture, surface, true)) {
          return false;
        }
        premult = premultTexture;
      }

      let blurred: WebGLTexture = straightTexture;
      if (amounts.clarity > 0) {
        targetA ??= new RenderTarget(context, false);
        targetB ??= new RenderTarget(context, false);
        blurInto(shaders.blur, targetA, premult, width, height, [render.clarityStep, 0], true);
        blurInto(shaders.blur, targetB, targetA.texture, width, height, [0, render.clarityStep], false);
        blurred = targetB.texture;
      }

      context.bindFramebuffer(context.FRAMEBUFFER, null);
      context.viewport(0, 0, width, height);
      context.disable(context.DEPTH_TEST);
      context.disable(context.BLEND);
      context.clearColor(0, 0, 0, 0);
      context.clear(context.COLOR_BUFFER_BIT);

      const program = shaders.finish;
      program.bind([straightTexture, premult, blurred]);
      const u = (name: string) => program.uniform(name);
      const inv = render.toLocal;
      context.uniform2f(u(FINISH_UNIFORM.size), width, height);
      context.uniform1f(u(FINISH_UNIFORM.clarity), amounts.clarity);
      context.uniform1f(u(FINISH_UNIFORM.sharpen), amounts.sharpen);
      context.uniform1f(u(FINISH_UNIFORM.particles), amounts.particles);
      context.uniform1f(u(FINISH_UNIFORM.fade), amounts.fade);
      context.uniform1f(u(FINISH_UNIFORM.vignette), amounts.vignette);
      context.uniform1f(u(FINISH_UNIFORM.sharpenStep), render.sharpenStep);
      context.uniform3f(u(FINISH_UNIFORM.toLocalX), inv.a, inv.c, inv.e);
      context.uniform3f(u(FINISH_UNIFORM.toLocalY), inv.b, inv.d, inv.f);
      context.uniform2f(u(FINISH_UNIFORM.box), render.box.width, render.box.height);
      context.uniform1f(u(FINISH_UNIFORM.grainCell), render.grainCell);
      context.uniform2f(
        u(FINISH_UNIFORM.grainOffset),
        render.grainOffset[0],
        render.grainOffset[1],
      );
      program.draw();

      if (lutBlocking()) {
        // Export reads the layer back on the next line; see `lut/apply.ts`.
        context.finish();
      }

      surface.ctx.save();
      surface.ctx.setTransform(1, 0, 0, 1, 0, 0);
      surface.ctx.globalAlpha = 1;
      surface.ctx.globalCompositeOperation = "copy";
      surface.ctx.drawImage(canvas, 0, 0, width, height);
      surface.ctx.restore();
      return true;
    },

    dispose(): void {
      blurProgram?.dispose();
      finishProgram?.dispose();
      blurProgram = null;
      finishProgram = null;
      targetA?.dispose();
      targetB?.dispose();
      targetA = null;
      targetB = null;
      for (const texture of [straightTexture, premultTexture]) {
        if (texture != null) {
          context.deleteTexture(texture);
        }
      }
      straightTexture = null;
      premultTexture = null;
    },
  };
}

/**
 * Re-rendering a frame in the page, the way the export renders it.
 *
 * This is the reference every fidelity comparison is made against, and its
 * whole value is that it is not a reimplementation: it calls
 * `renderTimelineAtTime` with `exportElementRenderers` after
 * `loadedAssetStore.seek`, which is `features/export/renderTimeline.ts`'s frame
 * loop body with the FFmpeg pipe removed. If the app changes how it draws a
 * frame, this changes with it.
 *
 * The one thing it must not skip is `loadEntireTimeline`. The export calls it
 * before the loop; without it there are no `<video>` handles at all, `seek`
 * iterates an empty list, and every frame composites to the background colour —
 * which looks exactly like a total rendering failure rather than like a missing
 * setup call.
 */

import type { Page } from "@playwright/test";

import type { FrameBuffer } from "./compare";

export type RenderMode = "export" | "preview";

export type ReferenceFrame = {
  frame: FrameBuffer;
  timeMs: number;
  /** `video.currentTime` per loaded clip after the seek, for diagnosis. */
  currentTimes: Record<string, number>;
};

/** Load every asset the timeline needs, once, before any reference render. */
export async function primeAssets(page: Page): Promise<{ videos: number }> {
  return page.evaluate(async () => {
    const C = (globalThis as any).CARTCUT;
    const timeline = C.useTimelineStore.getState().timeline;
    await C.loadedAssetStore.getState().loadEntireTimeline(timeline, { audio: false });
    return {
      videos: Object.keys(C.loadedAssetStore.getState()._loadedElementVideo ?? {}).length,
    };
  });
}

/**
 * Render frames at the given timeline positions and hand back their pixels.
 *
 * Batched rather than one call per frame: each round trip carries a full RGBA
 * frame (8.3 MB at 1080p) over the Playwright bridge as base64, and the
 * per-call overhead dominates otherwise. Callers pass small batches.
 *
 * `mode` selects which renderer table and which FX runtime to use — the export
 * pair (`renderVideoWithWait`, `createExportFxRuntime`) or the preview pair
 * (`renderVideoWithoutWait`, `previewFxRuntime`). Comparing the two is how the
 * suite tests the claim that the preview does not lie.
 */
export async function renderReferenceFrames(
  page: Page,
  timesMs: number[],
  mode: RenderMode = "export",
): Promise<ReferenceFrame[]> {
  const encoded = await page.evaluate(
    async ({ times, useMode }) => {
      const C = (globalThis as any).CARTCUT;
      const timeline = C.useTimelineStore.getState().timeline;
      const options = C.renderOptionStore.getState().options;
      const { w, h } = options.previewSize;

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

      const store = C.loadedAssetStore.getState();

      // Only build a GL runtime when the document actually has effects or
      // transitions — `renderTimeline` makes the same call, and creating one
      // otherwise allocates a canvas and a WebGL context for nothing.
      const needsFx =
        Object.values<any>(timeline).some(
          (e) => e.filetype === "effect" || e.filetype === "transition",
        );
      const fx = !needsFx
        ? null
        : useMode === "export"
          ? C.createExportFxRuntime(options.fps)
          : C.previewFxRuntime(options.fps, false);

      const renderers =
        useMode === "export" ? C.exportElementRenderers : (globalThis as any).__cartcutPreviewRenderers ?? C.exportElementRenderers;

      const out: Array<{ timeMs: number; b64: string; currentTimes: Record<string, number> }> = [];

      for (const timeMs of times) {
        await store.seek(timeline, timeMs);

        C.renderTimelineAtTime(
          ctx, timeline, timeMs, renderers,
          options.backgroundColor, w, h, undefined, undefined, fx,
        );

        const image = ctx.getImageData(0, 0, w, h);

        // Base64 rather than a plain array: Playwright serialises the return
        // value as JSON, and a 2-million-element number array is roughly
        // fifteen times the bytes and far slower to parse.
        let binary = "";
        const bytes = image.data;
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(
            null,
            bytes.subarray(i, i + CHUNK) as unknown as number[],
          );
        }

        const currentTimes: Record<string, number> = {};
        for (const meta of Object.values<any>(
          C.loadedAssetStore.getState()._loadedElementVideo ?? {},
        )) {
          currentTimes[meta.elementId] = meta.object.currentTime;
        }

        out.push({ timeMs, b64: btoa(binary), currentTimes });
      }

      fx?.compositor?.dispose?.();
      return { frames: out, width: w, height: h };
    },
    { times: timesMs, useMode: mode },
  );

  return encoded.frames.map((item) => ({
    timeMs: item.timeMs,
    currentTimes: item.currentTimes,
    frame: {
      data: Buffer.from(item.b64, "base64"),
      width: encoded.width,
      height: encoded.height,
    },
  }));
}

/**
 * The visible preview canvas, at project resolution.
 *
 * Not directly comparable to a reference render pixel for pixel, and the reason
 * is structural rather than incidental: `previewCanvas.ts` draws the scene into
 * an offscreen at *device* size with the viewport's pan and zoom baked in, then
 * composites a dimmed full-plane pass, a clipped in-frame pass, the frame guide
 * and any selection chrome over it. What comes back is the scene resampled at
 * an arbitrary zoom over a dimmed copy of itself. So this is used only for
 * structural comparison — ink bounds, centroids, a heavily downsampled mean.
 */
export async function capturePreviewCanvas(page: Page): Promise<FrameBuffer | null> {
  const encoded = await page.evaluate(() => {
    const canvas = document.querySelector("#elementPreviewCanvasRef") as HTMLCanvasElement | null;
    if (canvas == null) return null;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx == null) return null;
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < image.data.length; i += CHUNK) {
      binary += String.fromCharCode.apply(
        null,
        image.data.subarray(i, i + CHUNK) as unknown as number[],
      );
    }
    return { b64: btoa(binary), width: canvas.width, height: canvas.height };
  });

  if (encoded == null) return null;
  return {
    data: Buffer.from(encoded.b64, "base64"),
    width: encoded.width,
    height: encoded.height,
  };
}

/**
 * Put the preview in a state worth capturing.
 *
 * The preview draws whatever frame its `<video>` currently holds
 * (`renderVideoWithoutWait`), so a capture taken in the same tick as a cursor
 * move reads a pre-seek frame — and would flake on essentially every clip that
 * moves. Seeking explicitly, then letting two frames pass, is what makes the
 * capture mean anything.
 */
export async function settlePreviewAt(page: Page, timeMs: number): Promise<void> {
  await page.evaluate(async (t) => {
    const C = (globalThis as any).CARTCUT;
    C.selectionStore.getState().setIds([]);
    const timeline = C.useTimelineStore.getState().timeline;
    const control: any = document.querySelector("element-control");
    if (control?.isPlay) control.stop?.();
    C.useTimelineStore.getState().setCursor?.(t);
    await C.loadedAssetStore.getState().seek(timeline, t);
    const preview: any = document.querySelector("preview-canvas");
    preview?.scheduleDraw?.();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, timeMs);
}

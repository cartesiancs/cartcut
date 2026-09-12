/**
 * Baking a text clip into a picture of itself.
 *
 * The half of "render and replace" that needs a browser: an offscreen canvas to
 * draw the glyphs onto, a PNG encode, and an IPC round trip to put the bytes on
 * disk. The document edit that follows is pure and lives in
 * `features/timeline/rasterize.ts`.
 *
 * Three things here are easy to get wrong and expensive to notice later.
 *
 * **Fonts must have landed first.** `renderText` resolves `fontname` as a CSS
 * family; ask before the `@font-face` has loaded and the fallback face gets
 * baked permanently into a PNG, with no later event to fix it up. `text.ts`
 * clears its wrap cache on `loadingdone` for the same reason.
 *
 * **The picture is bigger than the box.** Shadow, glow and outline all paint
 * outside `width`×`height`. Rendering onto a canvas of exactly that size would
 * slice off precisely the effects this feature added, so the canvas grows by
 * `styleBleed` on every side and the image element's origin moves to match.
 *
 * **The bitmap is seeded into the asset cache.** `renderImage` draws nothing at
 * all when `loadedAssetStore` has no entry for a path, and loading is
 * asynchronous — so without seeding, the clip blinks out of existence between
 * the commit and the image finishing its own decode.
 *
 * One thing is deliberately lost: a **frosted background band** bakes as its
 * tint alone. `background.blur` is a backdrop blur, and a PNG of the clip by
 * itself has no backdrop — this canvas is empty, so no backdrop is passed and
 * `renderer/backdrop.ts` declines. Baking the frost would also be wrong: it
 * would freeze whatever happened to be behind the clip at one moment into a
 * picture that then moves independently of it.
 */

import type { TextElementType } from "../../@types/timeline";
import { measureTextBlock, renderText } from "../renderer/text";
import { resolveTextStyle, styleBleed } from "../text/style";
import { loadedAssetStore } from "../asset/loadedAssetStore";
import {
  rasterizeTextInDoc,
  type RasterBox,
} from "../timeline/rasterize";
import { useTimelineStore } from "../../states/timelineStore";

export type RasterizeResult =
  | { ok: true; elementId: string; localpath: string; box: RasterBox }
  | { ok: false; elementId: string; reason: string };

/**
 * Wait for webfonts, but never hang the command on a face that never arrives.
 *
 * Exported for the auto-caption panel, which draws text onto its own canvas and
 * has the same hazard this module opens with: ask before the `@font-face` has
 * loaded and the fallback face is what gets measured and drawn. The panel's
 * *first* caption is the one at risk, and it is the one a user judges the
 * feature by.
 */
export async function fontsSettled(timeoutMs = 3000): Promise<void> {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (fonts?.ready == null) {
    return;
  }
  await Promise.race([
    fonts.ready,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

/**
 * Draw one text element onto a fresh canvas, bleed included.
 *
 * Exported so the preview can offer a thumbnail of the result without
 * committing anything.
 */
export function drawTextToCanvas(
  element: TextElementType,
  timelineCursor: number,
): { canvas: HTMLCanvasElement; box: RasterBox } {
  const bleed = styleBleed(resolveTextStyle(element));

  // Measuring needs a context with the element's font already applied, which
  // is what `measureTextBlock` sets up. A scratch canvas is enough for that.
  const probe = document.createElement("canvas");
  const probeCtx = probe.getContext("2d");
  const measured =
    probeCtx == null
      ? { blockHeight: element.height }
      : measureTextBlock(probeCtx as CanvasRenderingContext2D, element);

  // The block can be taller than the element: `height` is the line *advance*,
  // so three wrapped lines occupy roughly three times it.
  const contentHeight = Math.max(element.height, Math.ceil(measured.blockHeight));

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(element.width + bleed * 2));
  canvas.height = Math.max(1, contentHeight + bleed * 2);

  const ctx = canvas.getContext("2d");
  if (ctx != null) {
    // No element transform here on purpose. `renderText` draws in local space
    // and `renderer/element.ts` applies rotation, scale and opacity around it —
    // the image twin inherits those, so baking them in would apply them twice.
    ctx.translate(bleed, bleed);
    renderText(ctx as CanvasRenderingContext2D, "raster", element, timelineCursor);
  }

  return {
    canvas,
    box: {
      x: element.location.x - bleed,
      y: element.location.y - bleed,
      width: canvas.width,
      height: canvas.height,
    },
  };
}

/** Put a decoded bitmap into the asset cache under the path it was saved at. */
function seedAssetCache(localpath: string, dataUrl: string): void {
  const img = new Image();
  img.src = dataUrl;
  loadedAssetStore.setState((state: any) => ({
    _loadedImage: { ...state._loadedImage, [localpath]: img },
  }));
}

/**
 * Rasterise every text clip in `elementIds`, as one undo step.
 *
 * Non-text clips in the selection are skipped rather than refused, so a mixed
 * selection does the obvious thing — the same courtesy `detachAudioFrom`
 * extends. A selection with no text at all leaves the document untouched by
 * identity and costs no history entry.
 */
export async function rasterizeTextElements(
  elementIds: string[],
  timelineCursor = 0,
): Promise<RasterizeResult[]> {
  await fontsSettled();

  const state = useTimelineStore.getState();
  const results: RasterizeResult[] = [];
  const baked: Array<{ elementId: string; localpath: string; box: RasterBox }> =
    [];

  for (const elementId of elementIds) {
    const element = state.timeline[elementId];
    if (element == null || element.filetype !== "text") {
      results.push({ ok: false, elementId, reason: "not a text clip" });
      continue;
    }

    const { canvas, box } = drawTextToCanvas(
      element as TextElementType,
      timelineCursor,
    );

    const blob = await toBlob(canvas);
    if (blob == null) {
      results.push({ ok: false, elementId, reason: "could not encode the PNG" });
      continue;
    }

    const saved = await window.electronAPI.req.filesystem.saveGeneratedAsset(
      await blob.arrayBuffer(),
      "png",
    );
    if (!saved?.status || typeof saved.path !== "string") {
      results.push({
        ok: false,
        elementId,
        reason: saved?.error ?? "could not write the image",
      });
      continue;
    }

    seedAssetCache(saved.path, canvas.toDataURL("image/png"));
    baked.push({ elementId, localpath: saved.path, box });
    results.push({ ok: true, elementId, localpath: saved.path, box });
  }

  if (baked.length > 0) {
    // One checkpoint for the whole batch: rasterising three selected titles is
    // one action to the user, so it must be one Cmd+Z.
    useTimelineStore.getState().withCheckpoint((doc) => {
      let next = doc;
      for (const { elementId, localpath, box } of baked) {
        next = rasterizeTextInDoc(next, elementId, localpath, box);
      }
      return next;
    });
  }

  return results;
}

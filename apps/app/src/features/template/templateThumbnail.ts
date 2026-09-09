/**
 * The picture a template shows in the library.
 *
 * Composited rather than screenshotted. Reading the preview canvas back would
 * be simpler and wrong: that context carries the editor's zoom and the
 * display's DPR on top of the project's own geometry — the exact trap
 * `renderer/mask.ts` documents about `worldMatrixOf` — so the thumbnail would
 * differ between two machines and between two zoom levels on one.
 *
 * The recipe is `agent/commands/contactSheet.ts`'s, shortened to one frame:
 * decode what the frame needs, seek to it, composite at project resolution with
 * the export renderers, then scale once into the thumbnail. Compositing at
 * thumbnail size instead would change every element's geometry and the tile
 * would stop being a picture of the template.
 */

import { renderOptionStore } from "../../states/renderOptionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { loadedAssetStore } from "../asset/loadedAssetStore";
import { exportElementRenderers } from "../export/renderers";
import { createExportFxRuntime } from "../renderer/fx/createRuntime";
import { hasFxElements } from "../renderer/fx/planFrame";
import { renderTimelineAtTime } from "../renderer/timeline";
import { assetTimeline } from "./assetTimeline";

/** Wide enough to read in a two-column grid on a Retina panel. */
const THUMBNAIL_WIDTH = 480;

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Render one frame of the current project as PNG bytes.
 *
 * Answers `null` rather than throwing on any failure. A template with no
 * thumbnail is a template with an icon on its tile, which is a great deal
 * better than an export that refused because a canvas would not allocate.
 */
export async function renderTemplateThumbnail(
  atMs: number,
): Promise<Uint8Array | null> {
  try {
    const timeline = useTimelineStore.getState().timeline;
    const options = renderOptionStore.getState().options;
    const { w: frameWidth, h: frameHeight } = options.previewSize;
    if (!(frameWidth > 0) || !(frameHeight > 0)) {
      return null;
    }

    const frame = document.createElement("canvas");
    frame.width = frameWidth;
    frame.height = frameHeight;
    const frameCtx = frame.getContext("2d");
    if (frameCtx == null) {
      return null;
    }

    // Expanded, because a template already on the timeline has its own clips
    // to decode — the split `template/assetTimeline.ts` states.
    const assets = assetTimeline(timeline);
    await loadedAssetStore.getState().loadEntireTimeline(assets, {
      audio: false,
    });
    await loadedAssetStore.getState().seek(assets, atMs, options.fps);

    const fx = hasFxElements(timeline)
      ? createExportFxRuntime(options.fps)
      : null;

    renderTimelineAtTime(
      frameCtx,
      timeline,
      atMs,
      exportElementRenderers,
      options.backgroundColor,
      frameWidth,
      frameHeight,
      undefined,
      undefined,
      fx,
    );

    const width = Math.min(THUMBNAIL_WIDTH, frameWidth);
    const height = Math.max(1, Math.round((width * frameHeight) / frameWidth));

    const thumb = document.createElement("canvas");
    thumb.width = width;
    thumb.height = height;
    const thumbCtx = thumb.getContext("2d");
    if (thumbCtx == null) {
      return null;
    }
    thumbCtx.drawImage(frame, 0, 0, frameWidth, frameHeight, 0, 0, width, height);

    return dataUrlToBytes(thumb.toDataURL("image/png"));
  } catch {
    return null;
  }
}

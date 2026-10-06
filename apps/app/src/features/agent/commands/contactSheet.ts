/**
 * A contact sheet of the composed timeline: what the edit actually looks like.
 *
 * Until now an agent editing this project has been working blind. It could read
 * the words and, since `analyze_audio`, hear the shape of the sound — but it
 * had no way to see a frame. So "is the caption on top of the speaker's face",
 * "did that cut land on black", "is the logo actually visible" were questions
 * it could only answer by asking the user to look.
 *
 * This renders the **composite**, not the source files: the same
 * `renderTimelineAtTime` the exporter drives, through the same renderer table
 * and the same FX runtime, so what comes back is the picture that would be
 * delivered. That is the part worth having. A filmstrip pulled out of the
 * source with ffmpeg would show the footage; this shows the edit.
 *
 * The recipe (decode into a video scope of its own, then `seekScope` then
 * `renderTimelineAtTime` per instant) is the one `export/renderTimeline.ts`
 * uses. Nothing here is a second way of drawing a frame.
 */

import { preloadForComposite } from "../../export/compositePrep";
import {
  needsHtmlHost,
  prepareScopeFrame,
  releaseScopeGraphics,
} from "../../graphic/graphicPipeline";
import { beginExportGraphics, endExportGraphics } from "../../graphic/graphicQueue";
import { paintHold } from "../../graphic/paintHold";
import { sheetWarning } from "./sheetWarning";
import {
  createGraphicScope,
  hasGraphicElements,
  withGraphicScope,
} from "../../graphic/graphicScope";
import { GraphicGl } from "../../renderer/graphicGl";
import { useTimelineStore } from "../../../states/timelineStore";
import { renderOptionStore } from "../../../states/renderOptionStore";
import { loadedAssetStore } from "../../asset/loadedAssetStore";
import { createVideoScope, withVideoScope, type VideoScope } from "../../asset/videoScope";
import { releaseOverlayScope } from "../../renderer/fx/overlaySource";
import { sheetAssets } from "./sheetAssets";
import { renderTimelineAtTime } from "../../renderer/timeline";
import { exportElementRenderers } from "../../export/renderers";
import { createExportFxRuntime } from "../../renderer/fx/createRuntime";
import { hasFxElements } from "../../renderer/fx/planFrame";
import { formatTimecode } from "../../timeline/timecode";
import { registerCommands } from "../registry";

/**
 * Most frames one sheet will draw.
 *
 * Each one costs a video seek, which is the slow part — a dozen is already a
 * few seconds. The cap is about the tool staying responsive rather than about
 * memory; a caller wanting more should ask for a second sheet over a second
 * range, which also keeps the image readable.
 */
const MAX_FRAMES = 16;

/** Widest a single tile is drawn. Beyond this the PNG stops being worth its size. */
const MAX_TILE_WIDTH = 640;

const DEFAULT_TILE_WIDTH = 320;

/** Height of the caption strip under each tile, in px at tile scale. */
const LABEL_HEIGHT = 22;

/** How long to wait for every video in the timeline to decode. */
const PRIME_TIMEOUT_MS = 30_000;

/**
 * Decode, into the sheet's own scope, every video it will draw, and wait until
 * each handle actually exists.
 *
 * A frame rendered without one of its clips **does not look broken**. It looks
 * like a black frame with the titles still on it, and an agent reading that
 * image will confidently act on a picture that was never real. So the load is
 * retried until every handle is there or the time runs out, and a shortfall is
 * reported rather than swallowed.
 */
async function primeScope(
  scope: VideoScope,
  assets: ReturnType<typeof useTimelineStore.getState>["timeline"],
  expected: number,
): Promise<{ loaded: number; expected: number }> {
  const deadline = Date.now() + PRIME_TIMEOUT_MS;
  let loaded = 0;

  do {
    await loadedAssetStore.getState().loadExportScope(scope, assets);
    loaded = Object.keys(scope.videos).length;
    if (loaded >= expected) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < deadline);

  return { loaded, expected };
}

registerCommands({
  /**
   * Draw `atMs` as a grid of composited frames and hand back a PNG.
   *
   * Returns base64 rather than writing the file here: the renderer has no
   * business choosing a location on disk, and main — which owns the tool, the
   * temp directory and the reply to the agent — does.
   */
  render_contact_sheet: async (params: {
    atMs: number[];
    columns?: number;
    tileWidth?: number;
  }) => {
    const times = (params.atMs ?? [])
      .filter((t) => Number.isFinite(t))
      .map((t) => Math.max(0, Math.round(t)))
      .slice(0, MAX_FRAMES);

    if (times.length === 0) {
      throw new Error("render_contact_sheet needs at least one time in `atMs`.");
    }

    const timeline = useTimelineStore.getState().timeline;
    const options = renderOptionStore.getState().options;
    const { w: frameWidth, h: frameHeight } = options.previewSize;

    const tileWidth = Math.min(
      MAX_TILE_WIDTH,
      Math.max(80, Math.round(params.tileWidth ?? DEFAULT_TILE_WIDTH)),
    );
    const tileHeight = Math.max(
      1,
      Math.round((tileWidth * frameHeight) / frameWidth),
    );
    const columns = Math.max(
      1,
      Math.min(times.length, Math.round(params.columns ?? 3)),
    );
    const rows = Math.ceil(times.length / columns);

    // One canvas at full project resolution to composite into, and one at tile
    // resolution to assemble. Compositing at the tile size instead would change
    // every element's geometry, and the sheet would stop being a preview of the
    // delivered picture.
    const frame = document.createElement("canvas");
    frame.width = frameWidth;
    frame.height = frameHeight;
    const frameCtx = frame.getContext("2d", { willReadFrequently: true });

    const sheet = document.createElement("canvas");
    sheet.width = columns * tileWidth;
    sheet.height = rows * (tileHeight + LABEL_HEIGHT);
    const sheetCtx = sheet.getContext("2d");

    if (frameCtx == null || sheetCtx == null) {
      throw new Error("Could not create a canvas to draw the contact sheet on.");
    }

    // The sheet's own decoders, as the export has. On the preview's, every
    // repaint (a graphic's raster landing is one) put the handles back at the
    // playhead between this sheet's seek and its draw.
    const scope = createVideoScope("sheet:" + Date.now());

    // Only when the document has one: building a runtime allocates a canvas and
    // a WebGL context, and most projects need neither. Its overlay videos are
    // the scope's too.
    const fx = hasFxElements(timeline) ? createExportFxRuntime(options.fps, scope.id) : null;

    sheetCtx.fillStyle = "#101010";
    sheetCtx.fillRect(0, 0, sheet.width, sheet.height);

    let primed = { loaded: 0, expected: 0 };

    // Templates, LUTs and fonts, as the exporter loads them. Without this a
    // sheet showed a template as empty space and a graded clip ungraded.
    const expanded = await preloadForComposite(timeline);

    // HTML graphics are rasterised from Chromium's paint, ahead of each frame,
    // into a scope of the sheet's own. A GLSL one draws in its generator.
    const graphics = hasGraphicElements(expanded)
      ? createGraphicScope(scope.id, new GraphicGl({ blocking: true }), options.fps)
      : null;
    const html = graphics != null && needsHtmlHost(expanded);
    // Painting, as an export does: an agent calls this while the editor sits
    // behind its terminal, where a throttled window paints nothing and every
    // graphic came out missing from the sheet.
    const releasePainting = html ? await paintHold.hold() : null;
    let graphicsPainted = true;

    try {
      // Expanded, so a template's own clips are decoded, and only the videos
      // these instants show. Audio handles are not decoded: nothing here plays.
      const needed = sheetAssets(expanded, times);
      primed = await primeScope(scope, needed.assets, needed.videos);

      for (let index = 0; index < times.length; index++) {
        const timeMs = times[index];

        // The same fps the exporter passes, so a frame is addressed the same
        // way here as it is there. See `loadedAssetStore#seek`.
        await loadedAssetStore.getState().seekScope(scope, expanded, timeMs, options.fps);
        if (html && graphics != null) {
          // The preview stands aside for this frame's prepare and no longer:
          // held across the whole sheet, a video seek that never landed kept
          // the preview from preparing any graphic for the rest of the session.
          beginExportGraphics();
          try {
            graphicsPainted = (await prepareScopeFrame(graphics, timeline, timeMs)) && graphicsPainted;
          } finally {
            endExportGraphics();
          }
        }

        // Synchronous, so neither scope can leak past this call.
        withGraphicScope(graphics, () =>
          withVideoScope(scope, () =>
            renderTimelineAtTime(
              frameCtx,
              timeline,
              timeMs,
              exportElementRenderers,
              options.backgroundColor,
              frameWidth,
              frameHeight,
              undefined,
              undefined,
              fx,
            ),
          ),
        );

        const column = index % columns;
        const row = Math.floor(index / columns);
        const x = column * tileWidth;
        const y = row * (tileHeight + LABEL_HEIGHT);

        sheetCtx.drawImage(frame, x, y, tileWidth, tileHeight);

        // The label is the point of the grid: an agent reading the image has to
        // be able to say *when* what it is looking at happens, or it cannot act
        // on it.
        sheetCtx.fillStyle = "#000000";
        sheetCtx.fillRect(x, y + tileHeight, tileWidth, LABEL_HEIGHT);
        sheetCtx.fillStyle = "#ffffff";
        sheetCtx.font = "13px monospace";
        sheetCtx.textBaseline = "middle";
        sheetCtx.fillText(
          `${timeMs}ms  ${formatTimecode(timeMs, options.fps)}`,
          x + 6,
          y + tileHeight + LABEL_HEIGHT / 2,
        );

        // A hairline between tiles, so two similar frames do not read as one.
        sheetCtx.strokeStyle = "#303030";
        sheetCtx.lineWidth = 1;
        sheetCtx.strokeRect(x + 0.5, y + 0.5, tileWidth - 1, tileHeight - 1);
      }
    } finally {
      // Every decoder this sheet opened. Nothing else can reach them.
      loadedAssetStore.getState().releaseVideoScope(scope);
      releaseOverlayScope(scope.id);
      fx?.compositor?.dispose?.();
      graphics?.gl?.dispose();
      if (graphics != null) {
        releaseScopeGraphics(graphics);
      }
      await releasePainting?.();
    }

    const dataUrl = sheet.toDataURL("image/png");

    return {
      // `data:image/png;base64,` stripped: main writes bytes, and handing it a
      // prefix it has to remember to remove is a trap.
      pngBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
      atMs: times,
      columns,
      rows,
      tileWidth,
      tileHeight,
      width: sheet.width,
      height: sheet.height,
      // Only when something is missing, so the ordinary result stays small —
      // and so a caller cannot read a complete sheet as an incomplete one.
      ...sheetWarning(primed, graphicsPainted),
    };
  },
});

import type { GifElementType } from "../../@types/timeline";
import { loadedAssetStore } from "../asset/loadedAssetStore";
import {
  composeTo,
  emptyComposeState,
  type GifComposePort,
  type GifComposeState,
} from "../gif/gifCompose";
import type { LoadedGif } from "../gif/gifDecode";
import { frameIndexAt } from "../gif/gifTiming";
import { makeSurface, type Surface } from "./surface";
import type { ElementRenderFunction } from "./type";

/**
 * One stage per element: the GIF's whole picture at the frame it last showed.
 *
 * Frames are patches laid over each other (`gif/gifCompose.ts`), so the
 * picture is built up on the stage and the stage is what reaches the frame.
 * Keeping it between draws is what makes playback and an export one patch per
 * frame rather than a rebuild from frame 0 every time.
 *
 * Per element rather than shared: two clips of one GIF at different times
 * would otherwise rebuild each other's picture on every draw.
 */
type GifStage = {
  surface: Surface;
  source: LoadedGif;
  state: GifComposeState<ImageData>;
  port: GifComposePort<ImageData>;
};

const stages = new Map<string, GifStage>();

function portFor(surface: Surface, source: LoadedGif): GifComposePort<ImageData> {
  const { ctx } = surface;
  return {
    clearAll: () => ctx.clearRect(0, 0, source.width, source.height),
    clearRect: (rect) => ctx.clearRect(rect.left, rect.top, rect.width, rect.height),
    drawFrame: (index) => {
      const patch = source.patches[index];
      const { rect } = source.frames[index];
      if (patch != null) {
        ctx.drawImage(patch, rect.left, rect.top);
      }
    },
    save: (rect) => ctx.getImageData(rect.left, rect.top, rect.width, rect.height),
    restore: (snapshot, rect) => ctx.putImageData(snapshot, rect.left, rect.top),
  };
}

function stageFor(elementId: string, source: LoadedGif): GifStage | null {
  const existing = stages.get(elementId);
  if (existing != null && existing.source === source) {
    return existing;
  }
  const surface = makeSurface(source.width, source.height);
  if (surface == null) {
    return null;
  }
  const stage: GifStage = {
    surface,
    source,
    state: emptyComposeState(),
    port: portFor(surface, source),
  };
  stages.set(elementId, stage);
  return stage;
}

export const renderGif: ElementRenderFunction<GifElementType> = (
  ctx,
  elementId,
  gifElement,
  timelineCursor,
) => {
  const loaded = loadedAssetStore.getState().getGif(gifElement.localpath);
  if (loaded == null) {
    return;
  }
  const index = frameIndexAt(loaded.timing, timelineCursor - gifElement.startTime);
  if (index < 0) {
    return;
  }
  const stage = stageFor(elementId, loaded);
  if (stage == null) {
    return;
  }

  stage.state = composeTo(stage.state, loaded.frames, index, stage.port);
  ctx.drawImage(stage.surface.canvas, 0, 0, gifElement.width, gifElement.height);
};

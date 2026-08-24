import type { GifElementType } from "../../@types/timeline";
import { loadedAssetStore } from "../asset/loadedAssetStore";
import type { ElementRenderFunction } from "./type";

/**
 * One staging canvas per element, holding whichever GIF frame it last drew.
 *
 * `putImageData` ignores the transformation matrix, so the frame has to be
 * staged and then blitted. It used to be staged again on *every* render:
 * exporting at 60 fps a GIF whose frames last 100 ms re-uploaded the same
 * pixels five times out of six. Keeping the decoded index alongside the canvas
 * turns those into a straight `drawImage`.
 *
 * Per element rather than shared: the single module-level canvas was also a
 * latent bug for two GIFs on screen at once, surviving only because the blit
 * happened to follow the upload immediately.
 */
type GifStage = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Which frame of which source is currently staged. */
  localpath: string | null;
  imageIndex: number;
};

const stages = new Map<string, GifStage>();

function stageFor(elementId: string): GifStage {
  const existing = stages.get(elementId);
  if (existing != null) {
    return existing;
  }
  const canvas = document.createElement("canvas");
  const stage: GifStage = {
    canvas,
    ctx: canvas.getContext("2d") as CanvasRenderingContext2D,
    localpath: null,
    imageIndex: -1,
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
  const loadedGif = loadedAssetStore.getState().getGif(gifElement.localpath);
  if (loadedGif == null) {
    // Can render skeleton here
    return;
  }
  const delay = loadedGif[0].parsedFrame.delay;

  const currentGifTime = timelineCursor - gifElement.startTime;
  const imageIndex = Math.floor(currentGifTime / delay) % loadedGif.length;
  const { imageData, parsedFrame } = loadedGif[imageIndex];

  const stage = stageFor(elementId);
  if (
    stage.imageIndex !== imageIndex ||
    stage.localpath !== gifElement.localpath
  ) {
    // Assigning a canvas dimension reallocates and clears the bitmap even when
    // the value is unchanged, so only touch it when it actually differs.
    if (stage.canvas.width !== parsedFrame.dims.width) {
      stage.canvas.width = parsedFrame.dims.width;
    }
    if (stage.canvas.height !== parsedFrame.dims.height) {
      stage.canvas.height = parsedFrame.dims.height;
    }
    stage.ctx.clearRect(0, 0, stage.canvas.width, stage.canvas.height);
    stage.ctx.putImageData(imageData, 0, 0);
    stage.imageIndex = imageIndex;
    stage.localpath = gifElement.localpath;
  }

  ctx.drawImage(stage.canvas, 0, 0, gifElement.width, gifElement.height);
};

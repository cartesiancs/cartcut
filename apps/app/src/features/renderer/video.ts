import type { VideoElementType } from "../../@types/timeline";
import { loadedAssetStore } from "../asset/loadedAssetStore";
import { VideoFilterPipeline } from "./filter/videoPipeline";
import type { ElementRenderFunction } from "./type";

export const renderVideoWithoutWait: ElementRenderFunction<VideoElementType> = (
  ctx,
  elementId,
  videoElement,
  timelineCursor,
) => {
  _renderVideo(ctx, elementId, videoElement, timelineCursor, false);
};

export const renderVideoWithWait: ElementRenderFunction<VideoElementType> = (
  ctx,
  elementId,
  videoElement,
  timelineCursor,
) => {
  _renderVideo(ctx, elementId, videoElement, timelineCursor, true);
};

const _renderVideo = (
  ctx: CanvasRenderingContext2D,
  elementId: string,
  videoElement: VideoElementType,
  timelineCursor: number,
  waitFilter: boolean,
) => {
  const store = loadedAssetStore.getState();
  const loadedVideo = store.getElementVideo(elementId);
  if (loadedVideo == null) {
    // Can render skeleton here
    return;
  }

  if (store.videoFilterPipeline == null) {
    store.videoFilterPipeline = new VideoFilterPipeline(
      store.videoFilterCanvasCtx,
    );
  }

  // There used to be a span check here, and removing it was necessary rather
  // than tidy.
  //
  // It was already redundant: `renderTimelineAtTime` calls
  // `isElementVisibleAtTime` before it calls any renderer, so a clip outside
  // its window never reached this function. Transitions made it actively
  // wrong. A cross-dissolve asks the outgoing clip to keep drawing *past* its
  // out-point — that is the whole mechanism — and this check, which knew only
  // `spanOf` and had no way to learn about the transition, answered "not
  // visible" and drew nothing. The dissolve would have blended against black
  // for its second half.
  //
  // Audibility is deliberately not decided here either, and never was: a
  // "mute me now" branch in this file could not fire for the clip that needs
  // it, which is why audio once kept playing over a cut.
  // `features/timeline/playback.ts` owns that, driven from the preview's draw
  // path where every handle is visited whether it is on screen or not.
  if (videoElement.filter.enable) {
    store.videoFilterPipeline.render(
      ctx,
      videoElement,
      loadedVideo,
      waitFilter,
    );
  } else {
    ctx.drawImage(
      loadedVideo.object,
      0,
      0,
      videoElement.width,
      videoElement.height,
    );
  }
};

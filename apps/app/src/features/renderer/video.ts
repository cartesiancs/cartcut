import type { VideoElementType } from "../../@types/timeline";
import { isTimeInRange } from "../../utils/time";
import { spanOf } from "../timeline/geometry";
import { loadedAssetStore } from "../asset/loadedAssetStore";
import { VideoFilterPipeline } from "./filter/videoPipeline";
import type { ElementRenderFunction } from "./type";

/**
 * Whether a video clip covers `timeInMs` on the timeline.
 *
 * This is `isElementVisibleAtTime` specialised to video: only text needs the
 * timeline (to resolve `parentKey`), so a clip can answer for itself. It
 * deliberately ignores `trim`, which addresses the *source file* for FFmpeg
 * seeking and says nothing about where the clip sits on the timeline.
 */
function isVideoVisibleAtTime(
  timeInMs: number,
  videoElement: VideoElementType,
): boolean {
  const { start, end } = spanOf(videoElement);
  return isTimeInRange(timeInMs, start, end);
}

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

  // renderTimelineAtTime already filters by visibility, but this also decides
  // whether the clip is audible, so it has to hold for any direct caller too.
  if (!isVideoVisibleAtTime(timelineCursor, videoElement)) {
    loadedVideo.object.muted = true;
    return;
  }
  loadedVideo.object.muted = false;

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

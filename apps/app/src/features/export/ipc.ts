import type { Timeline } from "../../@types/timeline";
import { loadedAssetStore } from "../asset/loadedAssetStore";
import type { TimelineRenderers } from "../renderer/timeline";
import { renderTimeline } from "./renderTimeline";
import type { ExportOptions } from "./types";

export async function requestIPCVideoExport(
  timeline: Timeline,
  elementRenderers: TimelineRenderers,
  options: ExportOptions,
  progressCallback: (currentFrame: number, totalFrames: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const assetStore = loadedAssetStore.getState();

  // Awaited: this used to be a fire-and-forget `send`, so frame 0 could reach
  // the main process before FFmpeg had spawned and worked only by luck of
  // ordering. It is also where a failure to launch now surfaces.
  const { sessionId } = await window.electronAPI.req.render.v2.start(
    options,
    timeline,
  );

  const cancel = () => {
    void window.electronAPI.req.render.v2.cancel(sessionId);
  };
  signal?.addEventListener("abort", cancel, { once: true });

  try {
    await renderTimeline(
      assetStore,
      timeline,
      elementRenderers,
      options,
      async (currentFrameBuffer, currentFrame, totalFrames) => {
        progressCallback(currentFrame, totalFrames);
        // Awaited: resolves once FFmpeg's stdin has room, which is what keeps
        // the renderer from outrunning the encoder now that frames are raw.
        await window.electronAPI.req.render.v2.sendFrame(
          currentFrameBuffer,
          sessionId,
        );
      },
      { signal },
    );

    // After the loop, not on the last frame: a zero-length project emits no
    // frames at all, and closing stdin from inside the callback then never
    // happened — leaving FFmpeg waiting on a pipe forever.
    await window.electronAPI.req.render.v2.finishStream(sessionId);
  } catch (error) {
    // An abort has already killed the process through the listener above; any
    // other failure has to, or FFmpeg sits forever on a stdin nobody will end.
    if (!signal?.aborted) {
      cancel();
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

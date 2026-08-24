import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { ReactiveController, ReactiveControllerHost } from "lit";
import type { Timeline } from "@app/@types/timeline";
import { loadedAssetStore } from "@app/features/asset/loadedAssetStore";
import { renderTimeline } from "@app/features/export/renderTimeline";
import type { ExportOptions } from "@app/features/export/types";
import { renderImage } from "@app/features/renderer/image";
import { renderVideoWithWait } from "@app/features/renderer/video";
import { renderGif } from "@app/features/renderer/gif";
import { renderText } from "@app/features/renderer/text";
import { renderShape } from "@app/features/renderer/shape";
import type { TimelineRenderers } from "@app/features/renderer/timeline";

/**
 * Offscreen export.
 *
 * Runs in a hidden window driven by the HTTP API. This used to be a 1,600-line
 * copy of the whole renderer; it now shares `renderTimeline` with the in-app
 * export (features/export/ipc.ts) and differs only in which IPC channel the
 * frames go down — `render:offscreen` instead of `render:v2`, and it reports
 * progress alongside each frame rather than through the progress modal.
 */

const elementRenderers: TimelineRenderers = {
  image: renderImage,
  video: renderVideoWithWait,
  gif: renderGif,
  text: renderText,
  shape: renderShape,
};

export class RenderController implements ReactiveController {
  private host: ReactiveControllerHost | undefined;
  timeline: Timeline = {};

  public requestRenderV2(timeline: Timeline, options: ExportOptions) {
    this.timeline = timeline;
    void this.runExport(options);
  }

  private async runExport(options: ExportOptions) {
    const assetStore = loadedAssetStore.getState();

    // Awaited, so frame 0 cannot reach the main process before FFmpeg has
    // spawned — it worked before only by luck of message ordering.
    await window.electronAPI.req.render.offscreen.start(options, this.timeline);

    // Progress used to be one socket.io message per frame. Throttling to
    // ~10 Hz keeps the bar smooth without a broadcast per frame.
    let lastReportedAt = 0;
    let percent = 0;

    await renderTimeline(
      assetStore,
      this.timeline,
      elementRenderers,
      options,
      async (frameBuffer, currentFrame, totalFrames) => {
        const isLast = currentFrame === totalFrames - 1;
        const now = performance.now();
        if (now - lastReportedAt >= 100 || isLast) {
          lastReportedAt = now;
          percent = (currentFrame / totalFrames) * 100;
        }

        // Awaited: resolves when FFmpeg's stdin has room, which is what stops
        // the renderer outrunning the encoder now that frames are raw.
        await window.electronAPI.req.render.offscreen.sendFrame(
          frameBuffer,
          percent,
        );
      },
    );

    // After the loop, not on the last frame: a zero-length project emits none,
    // and stdin would then never close, leaving FFmpeg on the pipe forever.
    await window.electronAPI.req.render.offscreen.finishStream();
  }

  hostConnected() {}
  hostDisconnected() {}
}

@customElement("offscreen-render")
export class OffscreenRender extends LitElement {
  private renderControl = new RenderController();

  constructor() {
    super();

    window.electronAPI.req.render.offscreen.readyToRender().then((result) => {
      this.renderControl.requestRenderV2(result.timeline, result.options);
    });

    window.electronAPI.res.render.offscreen.start((evt, result) => {
      this.renderControl.requestRenderV2(result.timeline, result.options);
    });
  }

  // ready to render 보내고 -> 서버 측에서 확인하면 이쪽으로 다시 timeline정보와 option 정보를 보내주면 그때부터 랜더링 시작

  render() {
    return html``;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "offscreen-render": OffscreenRender;
  }
}

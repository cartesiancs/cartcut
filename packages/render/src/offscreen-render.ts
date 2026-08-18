import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { ReactiveController, ReactiveControllerHost } from "lit";
import { decompressFrames, parseGIF } from "gifuct-js";
import {
  runFrameLoop,
  createPreloadedResolver,
  createVideoSeeker,
  createCanvasEncoder,
} from "@nugget/preview-engine";
import type {
  FrameSink,
  LoadedMedia,
  RenderTimeline,
} from "@nugget/preview-engine";

/**
 * Offscreen export.
 *
 * Runs in a hidden window driven by the HTTP API. Compositing is the shared
 * @nugget/preview-engine frame loop — identical to the in-app export in
 * apps/app/src/controllers/render.ts; only the IPC channel the frames go down
 * differs. These two files used to be near-identical 1,600-line copies of the
 * whole renderer.
 */

const RENDER_FPS = 60;

/** How long to let the preloads run before the first frame is composited. */
const PRELOAD_GRACE_MS = 2000;

export class RenderController implements ReactiveController {
  private host: ReactiveControllerHost | undefined;
  timeline: RenderTimeline = {};

  private loaded: LoadedMedia = {};
  private canvas = document.createElement("canvas");

  public requestRenderV2(timeline: RenderTimeline, options) {
    this.timeline = timeline;
    this.loadMedia(timeline);
    window.electronAPI.req.render.offscreen.start(options, this.timeline);

    setTimeout(() => {
      void this.runExport(options);
    }, PRELOAD_GRACE_MS);
  }

  private async runExport(options) {
    this.canvas.width = options.previewSize.w;
    this.canvas.height = options.previewSize.h;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;

    const sink: FrameSink = {
      sendFrame: (frame, percent) =>
        window.electronAPI.req.render.offscreen.sendFrame(frame, percent),
      finish: () => window.electronAPI.req.render.offscreen.finishStream(),
    };

    await runFrameLoop(
      ctx,
      this.timeline,
      {
        width: options.previewSize.w,
        height: options.previewSize.h,
        backgroundColor: options.backgroundColor,
      },
      { fps: RENDER_FPS, durationSec: options.videoDuration },
      {
        assets: createPreloadedResolver(this.loaded),
        prepareFrame: createVideoSeeker(this.loaded, this.timeline),
        encodeCanvas: createCanvasEncoder(this.canvas),
      },
      sink,
      {
        onFrameError: (error, frame) =>
          console.error(`offscreen render: frame ${frame} skipped`, error),
      },
    );
  }

  loadMedia(timeline: RenderTimeline) {
    this.timeline = timeline;
    this.loaded = {};

    for (const key in timeline) {
      if (!Object.prototype.hasOwnProperty.call(timeline, key)) continue;

      const element = timeline[key];

      if (element.filetype == "image") {
        const img = new Image();
        img.onload = () => {
          this.loaded[key] = img;
        };
        img.src = element.localpath as string;
      }

      if (element.filetype == "video") {
        const video = document.createElement("video");
        video.playbackRate = element.speed as number;
        video.src = element.localpath as string;

        video.addEventListener("loadeddata", () => {
          video.currentTime = 0;
          this.loaded[key] = video;
        });
      }

      if (element.filetype == "gif") {
        fetch(element.localpath as string)
          .then((resp) => resp.arrayBuffer())
          .then((buff) => {
            this.loaded[key] = decompressFrames(parseGIF(buff), true);
          });
      }
    }
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

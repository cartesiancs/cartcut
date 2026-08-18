import { ReactiveController, ReactiveControllerHost } from "lit";
import { rendererModal } from "../utils/modal";
import { renderOptionStore } from "../states/renderOptionStore";
import { useTimelineStore } from "../states/timelineStore";
import { decompressFrames, parseGIF } from "gifuct-js";
import {
  runFrameLoop,
  createPreloadedResolver,
  createVideoSeeker,
  createCanvasEncoder,
} from "@nugget/preview-engine";
import type {
  FrameSink,
  FrameLoopProgress,
  LoadedMedia,
  RenderTimeline,
} from "@nugget/preview-engine";

/**
 * In-app export.
 *
 * All compositing lives in @nugget/preview-engine — this controller only
 * collects the export options, preloads the media, and wires the engine's frame
 * loop to the `render:v2` IPC channel. The offscreen render window
 * (packages/render/src/offscreen-render.ts) is the same wiring against the
 * `render:offscreen` channel, which is why neither of them draws anything.
 */

const RENDER_FPS = 60;

export class RenderController implements ReactiveController {
  private host: ReactiveControllerHost | undefined;
  timeline: RenderTimeline = {};

  /** elementId -> preloaded Image / video element / decoded gif frames. */
  private loaded: LoadedMedia = {};
  private canvas = document.createElement("canvas");
  private frameTimestamps: number[] = [];

  public requestRenderV2() {
    const renderOptionState = renderOptionStore.getState().options;
    const elementControlComponent = document.querySelector("element-control");

    const projectDuration = renderOptionState.duration;
    const projectFolder = document.querySelector("#projectFolder").value;
    const projectRatio = elementControlComponent.previewRatio;
    const previewSizeH = renderOptionState.previewSize.h;
    const previewSizeW = renderOptionState.previewSize.w;
    const backgroundColor = renderOptionState.backgroundColor;

    const videoBitrate = Number(document.querySelector("#videoBitrate").value);

    if (projectFolder == "") {
      document
        .querySelector("toast-box")
        .showToast({ message: "Select a project folder", delay: "4000" });

      return 0;
    }

    this.loadMedia();

    window.electronAPI.req.dialog.exportVideo().then(async (result) => {
      let videoDestination = result || `nonefile`;
      if (videoDestination == `nonefile`) {
        return 0;
      }

      const isExistFile = await window.electronAPI.req.filesystem.existFile(
        videoDestination,
      );

      if (isExistFile) {
        await window.electronAPI.req.filesystem.removeFile(videoDestination);
      }

      const options = {
        videoDuration: projectDuration,
        videoDestination: result || `${projectFolder}/result.mp4`,
        videoDestinationFolder: projectFolder,
        videoBitrate: videoBitrate,
        previewRatio: projectRatio,
        backgroundColor: backgroundColor,
        previewSize: {
          w: previewSizeW,
          h: previewSizeH,
        },
      };

      this.canvas.width = previewSizeW;
      this.canvas.height = previewSizeH;
      const ctx = this.canvas.getContext("2d");
      if (!ctx) return 0;

      window.electronAPI.req.render.v2.start(options, this.timeline);

      const sink: FrameSink = {
        sendFrame: (frame) => window.electronAPI.req.render.v2.sendFrame(frame),
        finish: () => window.electronAPI.req.render.v2.finishStream(),
      };

      this.frameTimestamps = [];

      await runFrameLoop(
        ctx,
        this.timeline,
        {
          width: previewSizeW,
          height: previewSizeH,
          backgroundColor,
        },
        { fps: RENDER_FPS, durationSec: projectDuration },
        {
          assets: createPreloadedResolver(this.loaded),
          prepareFrame: createVideoSeeker(this.loaded, this.timeline),
          encodeCanvas: createCanvasEncoder(this.canvas),
        },
        sink,
        {
          onProgress: (progress) => this.showProgress(progress),
          onFrameError: (error, frame) =>
            console.error(`render: frame ${frame} skipped`, error),
        },
      );
    });
  }

  /**
   * Preload every asset the export will need. The frame loop's resolver treats a
   * missing entry as "not ready" and skips that element for the frame, so a slow
   * load degrades the first frames instead of crashing the render.
   */
  loadMedia() {
    this.timeline = useTimelineStore.getState().timeline;
    this.loaded = {};

    for (const key in this.timeline) {
      if (!Object.prototype.hasOwnProperty.call(this.timeline, key)) continue;

      const element = this.timeline[key];

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

  private showProgress({ percent }: FrameLoopProgress) {
    rendererModal.progressModal.show();
    document.querySelector("#progress").style.width = `${percent}%`;
    document.querySelector("#progress").innerHTML = `${Math.round(percent)}%`;

    this.frameTimestamps.push(Date.now());
    if (this.frameTimestamps.length > 2) {
      this.frameTimestamps.shift();
      const perPercent =
        (this.frameTimestamps[1] - this.frameTimestamps[0]) / 100;
      document.querySelector("#remainingTime").innerHTML = `${this.formatTime(
        Math.round(perPercent * (100 - percent)),
      )} left`;
    }
  }

  formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  hostConnected() {}
  hostDisconnected() {}
}

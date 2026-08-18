import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { IProjectStore, projectStore } from "../../states/projectStore";
import { useTimelineStore } from "../../states/timelineStore";
import { LocaleController } from "../../controllers/locale";
import { getLocationEnv } from "../../functions/getLocationEnv";
import axios from "axios";
import { renderOptionStore } from "../../states/renderOptionStore";
import { v4 as uuidv4 } from "uuid";
import { io } from "socket.io-client";
import { rendererModal } from "../../utils/modal";
import { requestIPCVideoExport } from "../../features/export/ipc";
import { renderImage } from "../../features/renderer/image";
import { renderVideoWithWait } from "../../features/renderer/video";
import { renderGif } from "../../features/renderer/gif";
import { renderText } from "../../features/renderer/text";
import { renderShape } from "../../features/renderer/shape";
import type { ExportOptions } from "../../features/export/types";
import { formatSeconds } from "../../utils/time";

let socket;

@customElement("control-ui-render")
export class ControlRender extends LitElement {
  private lc = new LocaleController(this);

  @property()
  projectState: IProjectStore = projectStore.getInitialState();

  @property()
  nowDirectory = this.projectState.nowDirectory;

  @property()
  videoSrc = "";
  httpRenderDoneModal: any;
  hasUpdatedOnce: boolean;

  renderTime: number[] = [];

  constructor() {
    super();
    this.hasUpdatedOnce = false;
  }

  createRenderRoot() {
    projectStore.subscribe((state) => {
      this.nowDirectory = state.nowDirectory;
    });

    if (getLocationEnv() == "web") {
      socket = io();

      socket.on("render:progress", (msg) => {
        rendererModal.progressModal.show();
        document.querySelector("#progress").style.width = `${msg}%`;
        document.querySelector("#progress").innerHTML = `${Math.round(msg)}%`;
      });

      socket.on("render:done", (path) => {
        rendererModal.progressModal.hide();

        document.querySelector("#progress").style.width = `100%`;
        document.querySelector("#progress").innerHTML = `100%`;

        this.videoSrc = `/api/file?path=${path}`;

        this.httpRenderDoneModal.show();
      });
    }

    return this;
  }

  updated() {
    if (this.hasUpdatedOnce == false) {
      this.httpRenderDoneModal = new bootstrap.Modal(
        document.getElementById("httpRenderDone"),
        {
          keyboard: false,
        },
      );
    }

    this.hasUpdatedOnce = true;
  }

  async requestHttpRender() {
    const tempPath = await window.electronAPI.req.app.getTempPath();
    const renderOptionState = renderOptionStore.getState().options;
    const elementControlComponent = document.querySelector("element-control");

    const projectDuration = renderOptionState.duration;
    const projectFolder = tempPath.path;
    const projectRatio = elementControlComponent.previewRatio;
    const previewSizeH = renderOptionState.previewSize.h;
    const previewSizeW = renderOptionState.previewSize.w;
    const backgroundColor = renderOptionState.backgroundColor;

    const videoBitrate = Number(document.querySelector("#videoBitrate").value);
    const uuidKey = uuidv4();

    if (projectFolder == "") {
      document
        .querySelector("toast-box")
        .showToast({ message: "Select a project folder", delay: "4000" });

      return 0;
    }

    let options = {
      videoDuration: projectDuration,
      videoDestination: `${projectFolder}/${uuidKey}.mp4`,
      videoDestinationFolder: projectFolder,
      videoBitrate: videoBitrate,
      previewRatio: projectRatio,
      backgroundColor: backgroundColor,
      previewSize: {
        w: previewSizeW,
        h: previewSizeH,
      },
    };

    let timeline = Object.fromEntries(
      Object.entries(useTimelineStore.getState().timeline).sort(
        ([, valueA]: any, [, valueB]: any) => valueA.priority - valueB.priority,
      ),
    );

    for (const key in timeline) {
      if (Object.prototype.hasOwnProperty.call(timeline, key)) {
        timeline[key].localpath = `file:/${timeline[key].localpath}`;
      }
    }

    axios.post("/api/render", {
      options: options,
      timeline: timeline,
    });
  }

  handleClickActionButton() {
    //this.renderControll.requestRender();
  }

  async handleClickRenderV2Button() {
    const optionsWithoutDestination: Omit<ExportOptions, "videoDestination"> = {
      ...renderOptionStore.getState().options,
      videoDuration: renderOptionStore.getState().options.duration,
      videoBitrate: Number(document.querySelector("#videoBitrate").value),
    };

    const elementRenderers = {
      image: renderImage,
      video: renderVideoWithWait,
      gif: renderGif,
      text: renderText,
      shape: renderShape,
    };

    const env = getLocationEnv();
    if (env == "electron") {
      const projectFolder = document.querySelector("#projectFolder").value;
      if (projectFolder == "") {
        document
          .querySelector("toast-box")
          .showToast({ message: "Select a project folder", delay: "4000" });
        return;
      }

      const ipc = window.electronAPI.req;

      const videoDestination = await ipc.dialog.exportVideo();
      if (videoDestination == null) {
        return;
      }

      const fileExists = await ipc.filesystem.existFile(videoDestination);
      if (fileExists) {
        await ipc.filesystem.removeFile(videoDestination);
      }

      const options = {
        ...optionsWithoutDestination,
        videoDestination,
      };

      requestIPCVideoExport(
        useTimelineStore.getState().timeline,
        elementRenderers,
        options,
        (currentFrame, totalFrames) => {
          const progressTo100 = (currentFrame / totalFrames) * 100;
          this.renderTime.push(Date.now());

          document.querySelector("#progress").style.width = `${progressTo100}%`;
          document.querySelector("#progress").innerHTML = `${Math.round(
            progressTo100,
          )}%`;
          rendererModal.progressModal.show();

          // TODO: Show proper ffmpeg progress
          if (this.renderTime.length > 2) {
            this.renderTime.shift();
            const rm = (this.renderTime[1] - this.renderTime[0]) / 100;
            document.querySelector(
              "#remainingTime",
            ).innerHTML = `${formatSeconds(
              Math.round(rm * (100 - progressTo100)),
            )} left`;
          }
        },
      );
    } else {
      this.requestHttpRender();
    }
  }

  render() {
    return html`
      <label class="form-label text-light"
        >${this.lc.t("setting.bitrate")}</label
      >
      <div class="input-group mb-3">
        <input
          id="videoBitrate"
          type="number"
          class="form-control bg-default text-light"
          placeholder=""
          value="5000"
        />
        <span class="input-group-text bg-default text-light" id="basic-addon2"
          >${this.lc.t("setting.bitrate_unit")}</span
        >
      </div>

      <br />
      <!-- <div class="text-light mb-2">
        <div class="form-check form-check-inline">
          <input
            class="form-check-input"
            type="radio"
            name="inputCheckBitrate"
            id="bitrate_row"
            value="1000"
            disabled
          />
          <label class="form-check-label">낮음</label>
        </div>
        <div class="form-check form-check-inline">
          <input
            class="form-check-input"
            type="radio"
            name="inputCheckBitrate"
            id="bitrate_high"
            value="5000"
            checked
          />
          <label class="form-check-label">높음</label>
        </div>
      </div> -->

      <button
        class="btn btn-blue-fill ${getLocationEnv() == "demo" ? "d-none" : ""}"
        @click=${this.handleClickRenderV2Button}
      >
        Render
      </button>

      <div
        class="modal fade"
        id="httpRenderDone"
        data-bs-keyboard="false"
        tabindex="-1"
      >
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content bg-dark">
            <div class="modal-body">
              <h5 class="modal-title text-white font-weight-lg">Render Done</h5>

              <div class="mt-3">
                <div class="flex row mb-3">
                  <button
                    class="btn btn-sm btn-default text-light mt-1"
                    @click=${() => window.open(this.videoSrc)}
                  >
                    Show File
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

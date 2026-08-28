import { LitElement, PropertyValues, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { uiStore } from "../../states/uiStore";
import { Buffer } from "buffer";
import { AssetController } from "../../controllers/asset";
import { projectFps } from "../editor/frameRate";

@customElement("screen-record-panel")
export class ScreenRecordPanel extends LitElement {
  canvasMaxHeight: any;
  video: HTMLVideoElement;
  isRecord: boolean;
  mediaRecorder: MediaRecorder | any;
  recordedChunks: any;
  startTime: number;
  endTime: number;
  hasUpdatedOnce: boolean;
  screenSources: never[];
  selectedValue: string;
  selectedText: string;
  constructor() {
    super();

    this.canvasMaxHeight = "100%";
    this.video = document.createElement("video");
    this.isRecord = false;
    this.mediaRecorder = undefined;
    this.recordedChunks = undefined;
    this.startTime = 0;
    this.endTime = 0;
    this.hasUpdatedOnce = false;
    this.screenSources = [];
    this.selectedValue = "";
    this.selectedText = "";
  }

  private assetControl = new AssetController();

  @query("#screenRecordCanvasRef") canvas!: HTMLCanvasElement;

  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property()
  control = this.timelineState.control;

  load() {
    const ctx = this.canvas.getContext("2d") as any;

    if (this.isRecord == false) {
      return;
    }

    this.canvas.width = this.video.videoWidth;
    this.canvas.height = this.video.videoHeight;

    ctx.drawImage(
      this.video,
      0,
      0,
      this.video.videoWidth,
      this.video.videoHeight,
    );

    window.requestAnimationFrame(this.load.bind(this));
  }

  stop() {
    this.isRecord = false;
    console.log(this.mediaRecorder);
    this.mediaRecorder.stop();
    this.requestUpdate();
  }

  async startRecording() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: 1920,
          height: 1080,
          // Capture at the rate the project runs at. A recording made at 60 for
          // a 30fps timeline throws half its frames away at import, and one
          // made at 60 for a 120fps timeline can never fill it.
          frameRate: projectFps(),
          deviceId: this.selectedValue,
        },
      });

      this.video.srcObject = stream;
      this.video.onloadedmetadata = () => this.video.play();

      this.mediaRecorder = new MediaRecorder(stream);
      this.recordedChunks = [];
      this.startTime = Date.now();

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          console.log("AAAAf");

          this.recordedChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.recordedChunks, { type: "video/webm" });
        this.endTime = Date.now();

        const duration = this.endTime - this.startTime;
        const arrayBuffer = await blob.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        window.electronAPI.req.stream.saveBufferToVideo(buffer).then((path) => {
          console.log(path, duration);

          if (path.status) {
            this.assetControl.addVideoWithDuration(path.path, duration);
          }
        });
      };

      this.mediaRecorder.start();
      this.isRecord = true;
      this.load();
      this.requestUpdate();
    } catch (err) {
      console.error("Error starting screen recording:", err);
    }
  }

  _handleClickRecord() {
    this.startRecording();
  }

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.control = state.control;
    });

    uiStore.subscribe((state) => {
      this.canvasMaxHeight =
        document.querySelector("#split_col_2").clientHeight;
    });

    return this;
  }

  protected updated(changedProperties: PropertyValues): void {
    if (this.hasUpdatedOnce == false) {
      window.electronAPI.req.desktopCapturer.getSources().then((result) => {
        if (result.status == 0) {
          return 0;
        }

        console.log(result);
        this.screenSources = result.sources;
        this.requestUpdate();
      });
    }

    this.hasUpdatedOnce = true;
  }

  handleChangeSelect(event) {
    const selectElement = event.target;
    this.selectedValue = selectElement.value;
    this.selectedText = selectElement.options[selectElement.selectedIndex].text;
  }

  render() {
    const selectMap: any = [];

    for (let index = 0; index < this.screenSources.length; index++) {
      const element = this.screenSources[index] as any;
      selectMap.push(
        html`<option value="${element.id}">${element.name}</option>`,
      );
    }
    return html`
      <div
        class="d-flex"
        style="flex-direction: column;
    padding: 1rem;     justify-content: center;
    align-items: center;
    gap: 1rem;"
      >
        <canvas
          id="screenRecordCanvasRef"
          style="width: 60%; max-height: calc(${this
            .canvasMaxHeight}px - 40px);"
          width="1920"
          height="1080"
        ></canvas>

        <div class="d-flex col gap-2">
          <select
            class="form-select bg-dark text-light form-select-sm"
            aria-label="select screen"
            @change=${this.handleChangeSelect}
          >
            ${selectMap}
          </select>

          <button
            class="btn btn-primary ${this.isRecord ? "d-none" : ""}"
            @click=${this._handleClickRecord}
          >
            record
          </button>
          <button
            class="btn btn-danger ${this.isRecord ? "" : "d-none"}"
            @click=${this.stop}
          >
            stop
          </button>
        </div>
      </div>
    `;
  }
}

import { LitElement, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import "./progress";

@customElement("automatic-caption")
export class AutomaticCaption extends LitElement {
  isLoadVideo: boolean;
  videoPath: string;
  isProgressProcessing: boolean;
  processingVideoModal: any;
  analyzingVideoModal: any;
  analyzedText: any[];
  selectVideoModal: any;
  selectedRow: any;
  videoRows: any;
  hasUpdatedOnce: boolean;
  panelVideoModal: any;
  isPlay: boolean;
  private _start: any;
  private _previousTimeStamp: any;
  private _done: boolean;
  private _animationFrameId: any;
  progress: number;
  previousProgress: number;
  splitCursor: number[];
  selectedKey: null;
  analyzedEditCaption: any[];
  mediaType: string;
  captionLocationY: number;
  targetTranslateLang: any;
  sttMethod: "local" | "openai";
  mediaDuration: number;
  resolution: { w: number; h: number };

  constructor() {
    super();

    this.isLoadVideo = false;
    this.isProgressProcessing = false;
    this.videoPath = "";
    this.mediaType = "";
    this.analyzedText = [];
    this.analyzedEditCaption = [];

    this.processingVideoModal = undefined;
    this.analyzingVideoModal = undefined;

    this.selectedRow = null;
    this.selectedKey = null;

    this.hasUpdatedOnce = false;

    this.isPlay = false;
    this.progress = 0;
    this.mediaDuration = 0;

    this.resolution = {
      w: 1920,
      h: 1080,
    };

    this.previousProgress = 0;

    this._start = undefined;
    this._previousTimeStamp = undefined;
    this._done = false;
    this._animationFrameId = null;

    this.targetTranslateLang = "en";

    this.sttMethod = "local";

    const fontSize = 52;
    const screenHeight = 1080;
    const yPadding = 100;

    this.captionLocationY = screenHeight - yPadding - fontSize;

    this.splitCursor = [0, 0];

    window.addEventListener("keydown", this._handleKeydown.bind(this));

    window.electronAPI.res.ffmpeg.extractAudioFromVideoProgress(
      (event, progress) => {
        //this.processingVideoModal.show();
        console.log(progress);
      },
    );

    window.electronAPI.res.ffmpeg.extractAudioFromVideoFinish(
      (event, outputWav) => {
        this.isProgressProcessing = true;
        setTimeout(() => {
          this.processingVideoModal.hide();
          this.analyzingVideoModal.show();
        }, 500);

        this.analyzeAudioToText(outputWav);
        this.requestUpdate();

        console.log(outputWav);
      },
    );
  }

  @query("#previewCanvasCaption") canvas!: HTMLCanvasElement;

  @property()
  timeline: any;

  @property()
  isDev = false;

  createRenderRoot() {
    return this;
  }

  handleRowSelection(
    rowId: any,
    key: any,
    mediaType: any,
    duration: any,
    resolution: { w: number; h: number },
  ) {
    this.selectedRow = rowId;
    this.selectedKey = key;
    this.mediaType = mediaType;
    this.mediaDuration = duration;
    this.resolution = {
      w: resolution.w,
      h: resolution.h,
    };
    console.log("Selected Row:", this.selectedRow, key);
    this.requestUpdate();
  }

  // 이벤트 처리
  applyCursorEvent(type) {
    this.dispatchEvent(
      new CustomEvent("changeCursorType", {
        detail: {
          type: type,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  async analyzeAudioToText(audioPath) {
    this.applyCursorEvent("lockKeyboard");

    if (this.sttMethod == "local") {
      const serverUrl = document.querySelector("#NuggetAutoServer").value;
      const response = await fetch(audioPath);

      if (!response.ok) {
        throw new Error(`Failed to fetch audio file: ${response.statusText}`);
      }

      const audioBlob = await response.blob();

      const formData = new FormData();
      formData.append("file", audioBlob, "audio.wav");

      const request = await axios.post(`${serverUrl}/api/audio/test`, formData);

      const result = request.data.result;

      this.analyzingVideoModal.hide();

      setTimeout(() => {
        this.analyzingVideoModal.hide();
      }, 1000);

      this.analyzedText = [];

      for (let index = 0; index < result.length; index++) {
        const element = result[index] as any;
        this.analyzedText.push(element.words);
        this.analyzedEditCaption.push(
          element.words
            .map((item: any) => {
              return item.word;
            })
            .join(" "),
        );
      }

      this.requestUpdate();

      this.panelVideoModal.show();
    }

    if (this.sttMethod == "openai") {
      window.electronAPI.req.ai.stt(audioPath).then((result) => {
        console.log(result);

        this.analyzingVideoModal.hide();

        setTimeout(() => {
          this.analyzingVideoModal.hide();
        }, 1000);

        this.analyzedText = [];

        let seg = result.text.segments.map((item) => {
          return {
            word: item.text,
            start: item.start,
            end: item.end,
            score: 1,
          };
        });

        for (let index = 0; index < seg.length; index++) {
          const element = seg[index] as any;
          this.analyzedText.push([element]);
          this.analyzedEditCaption.push(element.word);
        }

        this.requestUpdate();

        this.panelVideoModal.show();
      });
    }
  }

  async translateText() {
    try {
      const serverUrl = document.querySelector("#NuggetAutoServer").value;
      const formData = new FormData();
      formData.append("contents", JSON.stringify(this.analyzedEditCaption));
      formData.append("target_lang", this.targetTranslateLang);

      const request = await axios.post(`${serverUrl}/api/translate`, formData);

      const result = JSON.parse(request.data.result.content);

      console.log(result);

      this.analyzedEditCaption = [...result];
      this.appendAnalyzedEditCaption();
      this.requestUpdate();
    } catch (error) {
      // NOTE: alert 띄우기
    }
  }

  appendAnalyzedEditCaption() {
    for (let index = 0; index < this.analyzedEditCaption.length; index++) {
      try {
        document.querySelector(`#analyzedEditCaption_${index}`).value =
          this.analyzedEditCaption[index];
      } catch (error) {}
    }
  }

  async handleClickLoadVideo() {
    console.log(this.timeline);
    this.videoRows = this.timelineMap();
    this.requestUpdate();

    this.selectVideoModal.show();

    // window.electronAPI.req.dialog.openFile().then(async (result) => {
    //   const filePath = result;
    //   const fileType = mime.lookup(filePath).type;
    //   if (fileType == "video") {
    //     this.isLoadVideo = true;
    //     this.videoPath = filePath;
    //     this.processingVideoModal.show();

    //     const tempPath = await window.electronAPI.req.app.getTempPath();
    //     const outputAudio = tempPath.path + `${uuidv4()}.wav`;

    //     console.log(tempPath, outputAudio);

    //     window.electronAPI.req.ffmpeg.extractAudioFromVideo(
    //       outputAudio,
    //       filePath,
    //     );

    //     this.requestUpdate();
    //     // pass
    //   }
    // });
  }

  async handleClickSelectVideo() {
    this.applyCursorEvent("lockKeyboard");

    this.selectVideoModal.hide();
    this.isLoadVideo = true;

    this.videoPath = this.selectedRow;
    this.processingVideoModal.show();

    if (this.mediaType == "video") {
      const tempPath = await window.electronAPI.req.app.getTempPath();
      const outputAudio = tempPath.path + `${uuidv4()}.wav`;

      window.electronAPI.req.ffmpeg.extractAudioFromVideo(
        outputAudio,
        this.videoPath,
      );
    }

    if (this.mediaType == "audio") {
      this.isProgressProcessing = true;
      setTimeout(() => {
        this.processingVideoModal.hide();
        this.analyzingVideoModal.show();
      }, 500);

      this.analyzeAudioToText(this.videoPath);
      this.requestUpdate();
    }

    this.requestUpdate();
  }

  handleClickComplate() {
    this.analyzingVideoModal.hide();
    this.applyCursorEvent("pointer");

    const screenWidth = this.resolution.w;
    const screenHeight = this.resolution.h;
    const xPadding = 100;
    const yPadding = 100;
    const fontSize = 52;

    let resultArray: any = [];
    for (let index = 0; index < this.analyzedText.length; index++) {
      const element = this.analyzedText[index];
      const text = this.analyzedEditCaption[index];
      const x = xPadding;
      const y = this.captionLocationY;
      const w = screenWidth - xPadding * 2;
      const h = fontSize;

      const startTime = element[0].start * 1000;
      const duration =
        (element[element.length - 1].end - element[0].start) * 1000 || 1000;

      resultArray.push({
        // The clip that was transcribed. `startTime`/`duration` below are in
        // that file's own time, since that is what a transcript timestamps;
        // the app converts them to timeline time before placing the captions.
        sourceKey: this.selectedKey,
        text: text,
        textcolor: "#ffffff",
        fontsize: 52,
        optionsAlign: "center",
        backgroundEnable: true,
        locationX: x,
        locationY: y - fontSize,
        height: h + 12,
        width: w,
        startTime: startTime,
        duration: duration,
      });
    }

    this.dispatchEvent(
      new CustomEvent("editComplate", {
        detail: {
          result: resultArray,
        },
        bubbles: true,
        composed: true,
      }),
    );

    this.isLoadVideo = false;

    this.requestUpdate();
  }

  handleClickAlignCaptionButton(position: "center" | "bottom") {
    const fontSize = 52 + 12;
    const screenHeight = 1080;
    const yPadding = 100;

    switch (position) {
      case "center":
        this.captionLocationY = screenHeight / 2;
        break;

      case "bottom":
        this.captionLocationY = screenHeight - yPadding - fontSize;

        break;
      default:
        break;
    }
  }

  updated() {
    if (this.hasUpdatedOnce == false) {
      this.selectVideoModal = new bootstrap.Modal(
        document.getElementById("SelectVideo"),
        {
          keyboard: false,
        },
      );

      this.processingVideoModal = new bootstrap.Modal(
        document.getElementById("ProcessingVideo"),
        {
          keyboard: false,
        },
      );

      this.analyzingVideoModal = new bootstrap.Modal(
        document.getElementById("AnalyzingVideo"),
        {
          keyboard: false,
        },
      );

      this.panelVideoModal = new bootstrap.Modal(
        document.getElementById("VideoPanel"),
        {
          keyboard: false,
        },
      );
    }

    this.hasUpdatedOnce = true;
  }

  _step(timestamp) {
    if (this._start === undefined) {
      this._start = timestamp;
    }
    const elapsed = timestamp - this._start;
    this.progress = this.previousProgress + elapsed;

    if (this.mediaType == "video") {
      const video: HTMLVideoElement = document.querySelector(
        "#captionPreviewVideo",
      );

      const ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;
      ctx.drawImage(video, 0, 0, this.resolution.w, this.resolution.h);
    }

    this.showRightIndexCaption();

    this.requestUpdate();

    if (!this._done) {
      this._animationFrameId = window.requestAnimationFrame((ts) =>
        this._step(ts),
      );
    }
  }

  drawCaption(index) {
    const ctx = this.canvas.getContext("2d") as any;
    const fontSize = 52;
    const fontName = "notosanskr";

    const text = this.analyzedEditCaption[index];

    const screenWidth = this.resolution.w;
    const screenHeight = this.resolution.h;
    const xPadding = 100;
    const yPadding = 100;

    const x = xPadding;
    const y = this.captionLocationY;
    const w = screenWidth - xPadding * 2;
    const h = fontSize;

    let scaleW = w;
    let scaleH = h;
    let tx = x;
    let ty = y;

    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 0;
    ctx.letterSpacing = `0px`;

    ctx.font = `${fontSize}px ${fontName}`;

    this.drawTextBackground(ctx, text, tx, ty, scaleW, scaleH);
    ctx.fillStyle = "#ffffff";

    const textSplited = text.split(" ");
    let line = "";
    let textY = ty + fontSize;
    let lineHeight = h;

    for (let index = 0; index < textSplited.length; index++) {
      const testLine = line + textSplited[index] + " ";
      const metrics = ctx.measureText(testLine);
      const testWidth = metrics.width;

      if (testWidth < w) {
        line = testLine;
      } else {
        const wordWidth = ctx.measureText(line).width;

        ctx.fillText(line, tx + w / 2 - wordWidth / 2, textY);
        line = textSplited[index] + " ";
        textY += lineHeight;
      }
    }

    const lastWordWidth = ctx.measureText(line).width;

    ctx.fillText(line, tx + w / 2 - lastWordWidth / 2, textY);
    // const fontBoxWidth = ctx.measureText(text).width;

    // ctx.fillStyle = "#ffffff";

    // ctx.fillStyle = "#000000";
    // ctx.fillRect(x, y - fontSize, w, h + 6);

    // ctx.fillStyle = "#ffffff";

    // ctx.fillText(text, x + w / 2 - fontBoxWidth / 2, y);
  }

  drawTextBackground(ctx, text, x, y, w, h) {
    const backgroundPadding = 12;
    let backgroundX = x;
    let backgroundW = w;

    const textSplited = text.split(" ");
    let line = "";
    let textY = y;
    let lineHeight = h;

    for (let index = 0; index < textSplited.length; index++) {
      const testLine = line + textSplited[index] + " ";
      const metrics = ctx.measureText(testLine);
      const testWidth = metrics.width;

      if (testWidth < w) {
        line = testLine;
      } else {
        const wordWidth = ctx.measureText(line).width;

        backgroundX = x + w / 2 - wordWidth / 2 - backgroundPadding;
        backgroundW = wordWidth + backgroundPadding;

        ctx.fillStyle = "#000000";
        ctx.fillRect(backgroundX, textY, backgroundW, h);

        line = textSplited[index] + " ";
        textY += lineHeight;
      }
    }

    const wordWidth = ctx.measureText(line).width;
    backgroundX = x + w / 2 - wordWidth / 2 - backgroundPadding;
    backgroundW = wordWidth + backgroundPadding;

    ctx.fillStyle = "#000000";
    ctx.fillRect(backgroundX, textY, backgroundW, h);
  }

  showRightIndexCaption() {
    let nowCaptionIndex = 0;

    for (let index = 0; index < this.analyzedText.length; index++) {
      const element: any = this.analyzedText[index];
      let partText: any = [];

      for (let indexpart = 0; indexpart < element.length; indexpart++) {
        const partElement = element[indexpart];
        const isNow =
          this.progress / 1000 > partElement.start &&
          this.progress / 1000 < partElement.end + 1;

        if (isNow) {
          nowCaptionIndex = index;
          break;
        }
      }
    }

    console.log(nowCaptionIndex, "SSS");

    this.drawCaption(nowCaptionIndex);
  }

  playVideo() {
    this.isPlay = true;
    this._start = undefined;
    this._previousTimeStamp = undefined;
    this._done = false;

    if (this._animationFrameId) {
      window.cancelAnimationFrame(this._animationFrameId);
    }

    this._animationFrameId = window.requestAnimationFrame((ts) =>
      this._step(ts),
    );

    if (this.mediaType == "video") {
      const video: HTMLVideoElement = document.querySelector(
        "#captionPreviewVideo",
      );
      console.log(video);
      video.play();
    }

    if (this.mediaType == "audio") {
      const audio: HTMLAudioElement = document.querySelector(
        "#captionPreviewAudio",
      );
      audio.play();
    }

    this.requestUpdate();
  }

  stopVideo() {
    this.isPlay = false;
    this.previousProgress = this.progress;

    if (this.mediaType == "video") {
      const video: HTMLVideoElement = document.querySelector(
        "#captionPreviewVideo",
      );
      video.pause();
    }

    if (this.mediaType == "audio") {
      const audio: HTMLAudioElement = document.querySelector(
        "#captionPreviewAudio",
      );
      audio.pause();
    }

    if (this._animationFrameId) {
      window.cancelAnimationFrame(this._animationFrameId);
    }
    this._done = true;

    this.showRightIndexCaption();

    this.requestUpdate();
  }

  resetVideo() {
    this.isPlay = false;
    this._done = true;
    this.progress = 0;
    this.previousProgress = 0;

    if (this.mediaType == "video") {
      const video: HTMLVideoElement = document.querySelector(
        "#captionPreviewVideo",
      );
      video.currentTime = 0;

      const ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;
      ctx.drawImage(video, 0, 0, this.resolution.w, this.resolution.h);
    }

    if (this.mediaType == "audio") {
      const audio: HTMLAudioElement = document.querySelector(
        "#captionPreviewAudio",
      );
      audio.currentTime = 0;
    }

    this.showRightIndexCaption();

    this.requestUpdate();
  }

  clickCaptionText(e, index, indexPart, time) {
    this.stopVideo();
    if (time != -1) {
      this.progress = time * 1000;
      this.previousProgress = time * 1000;

      if (this.mediaType == "video") {
        const video: HTMLVideoElement = document.querySelector(
          "#captionPreviewVideo",
        );
        video.currentTime = time;

        const ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;
        ctx.drawImage(video, 0, 0, this.resolution.w, this.resolution.h);
      }

      if (this.mediaType == "audio") {
        const audio: HTMLAudioElement = document.querySelector(
          "#captionPreviewAudio",
        );
        audio.currentTime = time;
      }
    }

    this.showRightIndexCaption();

    console.log(e.target.offsetWidth, e.offsetX);
    if (e.offsetX / e.target.offsetWidth > 0.5) {
      this.splitCursor = [index, indexPart];
    } else {
      this.splitCursor = [index, indexPart - 1];
    }

    this.requestUpdate();
  }

  setSttMethod(method) {
    this.sttMethod = method;
    this.requestUpdate();
  }

  splitCaption() {
    const index = this.splitCursor[0];
    const indexPart = this.splitCursor[1] + 1;

    if (index < 0 || index > this.analyzedText.length) {
      throw new Error("Invalid index");
    }

    const prevValue = this.analyzedText[index].slice(0, indexPart);
    const nextValue = this.analyzedText[index].slice(indexPart);

    this.analyzedText.splice(index, 1, prevValue);

    this.analyzedText.splice(index + 1, 0, nextValue);

    let copyEditCaption = [...this.analyzedEditCaption];
    this.analyzedEditCaption = [];

    for (let itr = 0; itr < this.analyzedText.length; itr++) {
      const element = this.analyzedText[itr];
      let text = this.analyzedText[itr]
        .map((item: any) => {
          return item.word;
        })
        .join(" ");

      //   if (index == itr) {
      //     text = copyEditCaption[itr];
      //   }

      this.analyzedEditCaption.push(text);
    }
    this.appendAnalyzedEditCaption();
    this.requestUpdate();
  }

  _handleKeydown(event) {
    if (event.keyCode == 13) {
      // enter
      this.splitCaption();
    }
  }

  _handleChangeInput(event, index) {
    console.log(event, index);
    this.analyzedEditCaption[index] = event.target.value;
    this.requestUpdate();
  }

  _handleChangeTargetLang(event) {
    console.log(event.target.value);
    this.targetTranslateLang = event.target.value;
  }

  render() {
    let analyzedTextMap: any = [];

    for (let index = 0; index < this.analyzedText.length; index++) {
      const element: any = this.analyzedText[index];
      let partText: any = [];
      let analyzedText = "";

      for (let indexPart = 0; indexPart < element.length; indexPart++) {
        const partElement = element[indexPart];
        const isNow =
          this.progress / 1000 > partElement.start &&
          this.progress / 1000 < partElement.end;

        const isNowCursor =
          this.splitCursor[0] == index && this.splitCursor[1] == indexPart;

        analyzedText += partElement.word + " ";

        partText.push(
          html`<span
              @click=${(e) =>
                this.clickCaptionText(
                  e,
                  index,
                  indexPart,
                  partElement.start || -1,
                )}
              class="${isNow ? "caption-part active" : "caption-part"}"
              >${partElement.word}</span
            >
            <div class="${isNowCursor ? "caption-split" : "d-none"}"></div>`,
        );
      }
      analyzedTextMap.push(
        html`<span class="text-light caption"
          >${partText}
          <input
            @input=${(e) => this._handleChangeInput(e, index)}
            class="form-control bg-dark text-light mt-2"
            type="text"
            id="analyzedEditCaption_${index}"
            value=${this.analyzedEditCaption[index]}
          />
        </span>`,
      );
    }

    return html`
      <style>
        .caption {
          background-color: #19181a;
          color: #ffffff;
          padding: 0.5rem;
          border: 1px solid #26262b;
          border-radius: 8px;
          cursor: text;
        }

        .caption-part {
          background-color: #1b1a1c;
          color: #ffffff;
          margin-bottom: 0.1rem;
          outline: 1px solid #26262b;
          border-radius: 8px;
          height: fit-content;
          width: fit-content;
          display: inline-block;
        }

        .caption-part.active {
          background-color: #423d47;
          color: #ffffff;
          margin-bottom: 0.1rem;
          border: 2px solid #3838d3;
          border-radius: 8px;
          height: fit-content;
          width: fit-content;
          display: inline-block;
        }

        .caption-split {
          width: 2px;
          background-color: #5a5abe;
          height: 1.25rem;
          z-index: 9999;
          position: relative;
          display: inline-block;
        }
      </style>
      <div
        class="d-flex"
        style="flex-direction: column;
    padding: 1rem;     justify-content: center;
    align-items: center;
    gap: 1rem;"
      >
        <div class="d-flex gap-2 col">
          <button
            @click=${() => this.setSttMethod("local")}
            class="btn btn-sm ${this.sttMethod == "local"
              ? "btn-primary"
              : "btn-default"} text-light"
          >
            Local
          </button>
          <button
            @click=${() => this.setSttMethod("openai")}
            class="btn btn-sm ${this.sttMethod == "openai"
              ? "btn-primary"
              : "btn-default"} text-light"
          >
            OpenAI
          </button>
        </div>

        <div class="input-group ${this.sttMethod == "local" ? "" : "d-none"}">
          <span class="input-group-text bg-dark text-light" id="basic-addon2"
            >NuggetAutoServer</span
          >
          <input
            id="NuggetAutoServer"
            type="text"
            class="form-control bg-default bg-dark text-light ${this.isLoadVideo
              ? "d-none"
              : ""}"
            placeholder="http(s)://custom.domain:port"
            value="http://127.0.0.1:8000"
          />
        </div>

        <button
          class="btn btn-sm btn-default text-light mt-1 ${this.isLoadVideo
            ? "d-none"
            : ""}"
          @click=${this.handleClickLoadVideo}
        >
          Load video
        </button>
      </div>

      <div
        class="modal fade"
        id="ProcessingVideo"
        data-bs-keyboard="false"
        data-bs-backdrop="static"
        tabindex="-1"
      >
        <div class="modal-dialog modal-dialog-centered modal-lg">
          <div class="modal-content bg-dark">
            <div class="modal-body">
              <h5 class="modal-title text-white font-weight-lg">
                Extracting audio from video...
              </h5>

              <b class="text-secondary">Processing video... </b>
            </div>
          </div>
        </div>
      </div>

      <div
        class="modal fade"
        id="AnalyzingVideo"
        data-bs-keyboard="false"
        data-bs-backdrop="static"
        tabindex="-1"
      >
        <div class="modal-dialog modal-dialog-centered modal-lg">
          <div class="modal-content bg-dark">
            <div class="modal-body">
              <h5 class="modal-title text-white font-weight-lg">
                Analyzing video captions...
              </h5>

              <b class="text-secondary">Processing</b>
            </div>
          </div>
        </div>
      </div>

      <div
        class="modal fade"
        id="SelectVideo"
        data-bs-keyboard="false"
        data-bs-backdrop="static"
        tabindex="-1"
      >
        <div class="modal-dialog modal-dialog-centered modal-lg">
          <div class="modal-content">
            <div class="modal-body">
              <h5 class="modal-title font-weight-lg">
                Select video from Timeline
              </h5>

              <b class="text-secondary"
                >Selecting the video layer entered on the timeline</b
              >

              <table class="table table-striped ">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Video</th>
                    <th scope="col">Select</th>
                  </tr>
                </thead>
                <tbody>
                  ${this.renderRows()}
                </tbody>
              </table>

              <div class="mt-3">
                <div class="flex row gap-2">
                  <button
                    type="button"
                    class="col btn btn-secondary"
                    data-bs-dismiss="modal"
                  >
                    Close
                  </button>
                  <button
                    ?disabled=${this.selectedRow == null}
                    type="button"
                    class="col btn btn-primary"
                    data-bs-dismiss="modal"
                    @click=${this.handleClickSelectVideo}
                  >
                    Select
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        class="modal fade"
        id="VideoPanel"
        data-bs-keyboard="false"
        data-bs-backdrop="static"
        tabindex="-1"
      >
        <div class="modal-dialog modal-dialog-dark modal-fullscreen">
          <div class="modal-content modal-dark modal-darker">
            <div class="modal-body">
              <div class="d-flex col gap-2 mt-4">
                <div class="d-flex col-5 row gap-2" style="position: fixed;">
                  <canvas
                    id="previewCanvasCaption"
                    width=${this.resolution.w}
                    height=${this.resolution.h}
                  ></canvas>

                  <video
                    class="d-none col-3"
                    id="captionPreviewVideo"
                    src=${this.isDev ? "/test.MOV" : this.videoPath}
                  ></video>

                  <audio
                    class="d-none col-3"
                    id="captionPreviewAudio"
                    src=${this.videoPath}
                  ></audio>

                  <span class="text-light"
                    >${Math.round(this.progress / 1000)}s</span
                  >

                  <progress-bar
                    percent="${(Math.round(this.progress / 1000) /
                      (this.mediaDuration / 1000)) *
                    100}"
                  ></progress-bar>

                  <div class="d-flex col gap-2">
                    <button
                      class=" btn btn-sm btn-secondary"
                      @click=${this.resetVideo}
                    >
                      <span
                        class="material-symbols-outlined icon-white icon-md"
                      >
                        restart_alt
                      </span>
                    </button>
                    <button
                      class="${this.isPlay
                        ? "d-none"
                        : ""} btn btn-sm btn-secondary"
                      @click=${this.playVideo}
                    >
                      <span
                        class="material-symbols-outlined icon-white icon-md"
                      >
                        play_circle
                      </span>
                    </button>

                    <button
                      class="${!this.isPlay
                        ? "d-none"
                        : ""}  btn btn-sm btn-danger"
                      @click=${this.stopVideo}
                    >
                      <span
                        class="material-symbols-outlined icon-white icon-md"
                      >
                        stop_circle
                      </span>
                    </button>
                  </div>
                  <div class="d-flex col gap-2">
                    <button
                      class=" btn btn-sm btn-secondary"
                      @click=${() =>
                        this.handleClickAlignCaptionButton("center")}
                    >
                      align center
                    </button>
                    <button
                      class=" btn btn-sm btn-secondary"
                      @click=${() =>
                        this.handleClickAlignCaptionButton("bottom")}
                    >
                      align bottom
                    </button>
                  </div>

                  <button
                    type="button"
                    class="btn btn-primary  btn-sm w-auto"
                    data-bs-toggle="modal"
                    data-bs-target="#TranslateText"
                  >
                    Translate
                  </button>
                </div>

                <div
                  class="col-6"
                  style="position: absolute;
    right: 20px;"
                >
                  <div class="d-flex row gap-2">${analyzedTextMap}</div>
                </div>
              </div>
            </div>
            <div class="modal-footer modal-footer-dark ">
              <div class="flex row gap-2">
                <button
                  type="button"
                  class="col btn btn-sm btn-secondary btn-nowarp"
                  data-bs-dismiss="modal"
                  @click=${() => {
                    this.isLoadVideo = false;
                    this.analyzingVideoModal.hide();
                    this.requestUpdate();
                  }}
                >
                  Close
                </button>
                <button
                  type="button"
                  class="col btn btn-sm btn-primary btn-nowarp"
                  data-bs-dismiss="modal"
                  @click=${this.handleClickComplate}
                >
                  Complate Edit
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="modal fade" id="TranslateText" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered modal-lg">
          <div class="modal-content bg-dark">
            <div class="modal-body">
              <h5 class="modal-title text-white font-weight-lg">
                Translate Text...
              </h5>

              <b class="text-secondary">Select target language</b>

              <select
                @change=${this._handleChangeTargetLang}
                ref="lists"
                id="fontSelect"
                class="form-select form-control bg-default text-light"
                aria-label="Select target lang"
              >
                <option value="en" selected>English</option>
                <option value="ko">Korean</option>
              </select>

              <button
                type="button"
                @click=${this.translateText}
                class="btn btn-primary  btn-sm"
                data-bs-dismiss="modal"
              >
                Translate
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  timelineMap(): {
    id: number;
    video?: string;
    key: string;
    filetype: string;
    duration: number;
    resolution: {
      w: number;
      h: number;
    };
  }[] {
    const timeline = this.timeline;
    const timelineArray: {
      id: number;
      video?: string;
      key: string;
      filetype: string;
      duration: number;
      resolution: {
        w: number;
        h: number;
      };
    }[] = [];
    let index = 1;

    for (const key in timeline) {
      if (Object.prototype.hasOwnProperty.call(timeline, key)) {
        const element = timeline[key];

        if (element.filetype == "video") {
          timelineArray.push({
            id: index,
            video: element.localpath,
            key: key,
            filetype: element.filetype,
            duration: element.duration,
            resolution: {
              w: element.origin.width,
              h: element.origin.height,
            },
          });
          index += 1;
        }

        if (element.filetype == "audio") {
          timelineArray.push({
            id: index,
            video: element.localpath,
            key: key,
            filetype: element.filetype,
            duration: element.duration,
            resolution: {
              w: 1920,
              h: 1080,
            },
          });
          index += 1;
        }
      }
    }

    console.log(timelineArray);

    return timelineArray;
  }

  renderRows() {
    try {
      return this.videoRows.map(
        (row) => html`
          <tr
            @click="${() =>
              this.handleRowSelection(
                row.video,
                row.key,
                row.filetype,
                row.duration,
                {
                  w: row.resolution.w,
                  h: row.resolution.h,
                },
              )}"
          >
            <th scope="row">${row.id}</th>
            <td>${row.video}</td>
            <td>
              <input
                type="radio"
                name="videoSelect"
                .checked="${this.selectedRow === row.video}"
              />
            </td>
          </tr>
        `,
      );
    } catch (error) {
      return html``;
    }
  }
}

import { LitElement, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { v4 as uuidv4 } from "uuid";
import {
  chooseDefaultLocale,
  sortLocales,
} from "../../app/src/features/caption/locale";
import "./progress";

@customElement("automatic-caption")
export class AutomaticCaption extends LitElement {
  isLoadVideo: boolean;
  videoPath: string;
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
  sttMethod: "apple" | "openai";
  mediaDuration: number;
  resolution: { w: number; h: number };

  /** Languages this Mac can transcribe, and whether it can at all. */
  locales: { id: string; name: string; installed: boolean }[];
  selectedLocale: string;
  speechAvailable: boolean;
  speechReason: string;

  /** The running job. Minted here so a model download can be cancelled. */
  jobId: string | null;
  progressFraction: number;
  progressStage: string;
  private _unsubscribeProgress: (() => void) | null;

  constructor() {
    super();

    this.isLoadVideo = false;
    this.videoPath = "";
    this.mediaType = "";
    this.analyzedText = [];
    this.analyzedEditCaption = [];

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

    this.locales = [];
    this.selectedLocale = "";
    this.speechAvailable = false;
    this.speechReason = "";

    this.jobId = null;
    this.progressFraction = 0;
    this.progressStage = "";
    this._unsubscribeProgress = null;

    this.sttMethod = "apple";

    const fontSize = 52;
    const screenHeight = 1080;
    const yPadding = 100;

    this.captionLocationY = screenHeight - yPadding - fontSize;

    this.splitCursor = [0, 0];

    window.addEventListener("keydown", this._handleKeydown.bind(this));

    // Audio extraction used to happen here, through the legacy fluent-ffmpeg
    // IPC, with the result arriving as a fire-and-forget event. Main owns the
    // whole job now — extract, then recognise — so there is one promise to
    // await and one place a failure can come from.
    const api = this._transcribeApi();
    if (api != null) {
      this._unsubscribeProgress = api.onProgress((payload: any) => {
        // Progress for a job we are no longer waiting on is not ours to draw.
        if (payload?.jobId !== this.jobId) {
          return;
        }
        this.progressFraction = payload.fraction ?? 0;
        this.progressStage = payload.stage ?? "";
        this.requestUpdate();
      });

      api.locales().then((result: any) => {
        this.speechAvailable = result?.available === true;
        this.speechReason = result?.reason ?? "";
        this.locales = sortLocales(result?.locales ?? []);
        this.selectedLocale = this._defaultLocale();
        // Falling back silently would transcribe with OpenAI while the button
        // still said On-device.
        if (!this.speechAvailable) {
          this.sttMethod = "openai";
        }
        this.requestUpdate();
      });
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribeProgress?.();
    this._unsubscribeProgress = null;
  }

  private _transcribeApi(): any {
    // Null in the web build, which has no main process behind the bridge.
    return (window as any).electronAPI?.req?.transcribe ?? null;
  }

  /**
   * The language to offer first.
   *
   * `navigator.languages` is the user's own ranked list, which is more than
   * `navigator.language` alone knows: a Korean user running macOS in English
   * has `ko-KR` in it. The rule itself lives in `features/caption/locale.ts`
   * because this file is outside every test include pattern and getting it
   * wrong is invisible — the first version offered South African English to an
   * `en-US` user and looked entirely reasonable doing it.
   */
  private _defaultLocale(): string {
    const preferences = [
      ...(navigator.languages ?? []),
      navigator.language ?? "",
    ];
    return chooseDefaultLocale(this.locales, preferences);
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

  /**
   * Transcribe the selected clip.
   *
   * One call into main, which extracts the audio and runs the recogniser. The
   * panel used to do the first half itself through the legacy fluent-ffmpeg IPC
   * and the second half with `axios`, against a server the user had to run and
   * whose URL lived in a DOM input. Both halves are gone: main's `transcribeFile`
   * is the same function the MCP `get_transcript` tool calls, so the two share
   * one disk cache and a clip the agent has already read opens instantly here.
   */
  async transcribeSelectedClip() {
    const api = this._transcribeApi();
    if (api == null) {
      this._failAnalysis("Transcription needs the desktop app.");
      return;
    }

    // Minted before the call so Cancel works during a first-run model download,
    // which is the long wait and resolves `start` only when it finishes.
    this.jobId = uuidv4();
    this.progressFraction = 0;
    this.progressStage = "extracting";
    this.requestUpdate();

    let result: any;
    try {
      result = await api.start(this.jobId, {
        source: this.videoPath,
        method: this.sttMethod,
        locale: this.sttMethod === "apple" ? this.selectedLocale : undefined,
      });
    } catch (error) {
      this._failAnalysis(String(error));
      return;
    } finally {
      this.jobId = null;
    }

    if (result?.ok !== true) {
      if (result?.cancelled === true) {
        this._endAnalysis();
        return;
      }
      this._failAnalysis(result?.error ?? "Transcription failed.");
      return;
    }

    this.analyzedText = [];
    this.analyzedEditCaption = [];

    for (const line of result.lines) {
      // Into the panel's own word shape: seconds rather than ms, and `score`
      // for what a back end calls confidence. Everything downstream — the word
      // chips, the split cursor, the preview — already speaks it, so none of it
      // had to change.
      this.analyzedText.push(
        line.map((word: any) => ({
          word: word.word,
          start: word.startMs / 1000,
          end: word.endMs / 1000,
          score: word.confidence ?? 1,
        })),
      );
      this.analyzedEditCaption.push(
        line.map((word: any) => word.word).join(" "),
      );
    }

    this.analyzingVideoModal.hide();
    this.requestUpdate();
    this.panelVideoModal.show();
  }

  /** Give the keyboard back and close the progress modal. */
  _endAnalysis() {
    this.analyzingVideoModal?.hide();
    this.isLoadVideo = false;
    this.jobId = null;
    this.applyCursorEvent("pointer");
    this.requestUpdate();
  }

  _failAnalysis(message: string) {
    this._endAnalysis();
    // The old local path swallowed every failure into an empty catch with a
    // `// NOTE: alert 띄우기` beside it, so a server that was not running looked
    // exactly like a clip with no speech in it.
    window.alert(message);
  }

  cancelAnalysis() {
    const api = this._transcribeApi();
    if (api != null && this.jobId != null) {
      void api.cancel(this.jobId);
    }
    this._endAnalysis();
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
    this.videoRows = this.timelineMap();
    this.requestUpdate();

    this.selectVideoModal.show();
  }

  async handleClickSelectVideo() {
    this.applyCursorEvent("lockKeyboard");

    this.selectVideoModal.hide();
    this.isLoadVideo = true;
    this.videoPath = this.selectedRow;

    // One path for video and audio alike: main runs ffmpeg over whatever it is
    // handed. The panel used to skip extraction for audio and give the file
    // straight to the recogniser, which was two flows and two ways to fail.
    this.analyzingVideoModal.show();
    this.requestUpdate();

    await this.transcribeSelectedClip();
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

  setSttMethod(method: "apple" | "openai") {
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
    // This listener is on `window`, so it hears every Enter in the editor — not
    // just the ones meant for the caption list. Without the guard, an Enter
    // pressed before anything has been transcribed indexes an empty array and
    // throws inside `splitCaption`.
    if (event.keyCode == 13 && this.analyzedText.length > 0) {
      this.splitCaption();
    }
  }

  _handleChangeInput(event, index) {
    console.log(event, index);
    this.analyzedEditCaption[index] = event.target.value;
    this.requestUpdate();
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
            @click=${() => this.setSttMethod("apple")}
            ?disabled=${!this.speechAvailable}
            class="btn btn-sm ${this.sttMethod == "apple"
              ? "btn-primary"
              : "btn-default"} text-light"
          >
            On-device
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

        ${this.speechAvailable
          ? html``
          : html`<span class="text-secondary" style="font-size: 0.75rem;"
              >${this.speechReason}</span
            >`}

        <div class="input-group ${this.sttMethod == "apple" ? "" : "d-none"}">
          <span class="input-group-text bg-dark text-light">Language</span>
          <select
            id="CartcutSttLocale"
            class="form-select form-control bg-default bg-dark text-light"
            @change=${(e) => {
              this.selectedLocale = e.target.value;
              this.requestUpdate();
            }}
          >
            ${this.locales.map(
              (locale) => html`<option
                value=${locale.id}
                ?selected=${locale.id === this.selectedLocale}
              >
                ${locale.name}${locale.installed ? "" : " (downloads once)"}
              </option>`,
            )}
          </select>
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
        id="AnalyzingVideo"
        data-bs-keyboard="false"
        data-bs-backdrop="static"
        tabindex="-1"
      >
        <div class="modal-dialog modal-dialog-centered modal-lg">
          <div class="modal-content bg-dark">
            <div class="modal-body">
              <h5 class="modal-title text-white font-weight-lg">
                ${this.progressStage == "downloading"
                  ? "Downloading the language model..."
                  : this.progressStage == "extracting"
                    ? "Extracting audio..."
                    : "Transcribing..."}
              </h5>

              <b class="text-secondary"
                >${this.progressStage == "downloading"
                  ? "This happens once per language, and the model stays on this Mac."
                  : "The audio never leaves your computer."}</b
              >

              <progress-bar
                percent="${Math.round(this.progressFraction * 100)}"
              ></progress-bar>

              <div class="d-flex justify-content-end mt-3">
                <button
                  type="button"
                  class="btn btn-sm btn-secondary"
                  @click=${this.cancelAnalysis}
                >
                  Cancel
                </button>
              </div>
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

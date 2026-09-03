/**
 * The screen-record panel: a live preview of the screen, and a button that
 * records it.
 *
 * The preview runs whenever the panel is the visible one, not only while
 * recording — you have to see what you are about to capture before you commit
 * to capturing it. That distinction is the whole reason for the machinery here:
 * `Control.ts` mounts this component once at startup and only toggles `d-none`
 * on it, so `connectedCallback` says nothing about whether anyone is looking.
 * A capture started there would hold the screen — and the OS recording
 * indicator — for the entire life of the app. So the stream follows
 * `controlPanelStore.nowActive` instead.
 *
 * The recorder then records *the preview's own stream*, which is what makes the
 * source `<select>` mean anything. It previously did nothing at all: the
 * `deviceId` it set is ignored by `getDisplayMedia`, and
 * `lib/window.ts`'s `setDisplayMediaRequestHandler` hands back `sources[0]`
 * unconditionally, so every recording captured the first screen whatever the
 * dropdown said.
 */

import { LitElement, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { uiStore } from "../../states/uiStore";
import { controlPanelStore } from "../../states/controlPanelStore";
import { Buffer } from "buffer";
import { saveAndImportRecording } from "./saveRecording";
import { projectFps } from "../editor/frameRate";

@customElement("screen-record-panel")
export class ScreenRecordPanel extends LitElement {
  canvasMaxHeight: any;
  video: HTMLVideoElement;
  isRecord: boolean;
  mediaRecorder: MediaRecorder | any;
  /** Held so the preview can be released — the OS indicator stays on otherwise. */
  stream: MediaStream | null;
  /** The source the live stream is of, so a re-select is a no-op. */
  streamSourceId: string;
  /** Set while a preview stream is being acquired, to stop a second attempt. */
  isStartingPreview: boolean;
  /** The paint loop's handle, so it is never started twice. */
  paintHandle: number | null;
  recordedChunks: any;
  startTime: number;
  endTime: number;
  hasLoadedSources: boolean;
  screenSources: { id: string; name: string }[];
  selectedValue: string;
  selectedText: string;
  previewError: string;
  private unsubscribePanel?: () => void;

  constructor() {
    super();

    this.canvasMaxHeight = "100%";
    this.video = document.createElement("video");
    // A detached element still decodes and still paints; it only has to be
    // told it is allowed to start without a user gesture.
    this.video.muted = true;
    this.video.playsInline = true;
    this.isRecord = false;
    this.mediaRecorder = undefined;
    this.stream = null;
    this.streamSourceId = "";
    this.isStartingPreview = false;
    this.paintHandle = null;
    this.recordedChunks = undefined;
    this.startTime = 0;
    this.endTime = 0;
    this.hasLoadedSources = false;
    this.screenSources = [];
    this.selectedValue = "";
    this.selectedText = "";
    this.previewError = "";
  }

  @query("#screenRecordCanvasRef") canvas!: HTMLCanvasElement;

  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property()
  control = this.timelineState.control;

  /**
   * Paint the live stream onto the preview canvas, once per frame.
   *
   * Driven by the stream rather than by `isRecord`, which is what it used to
   * read — that is why nothing appeared until the record button was pressed.
   *
   * Every early return here reschedules rather than stopping. The first few
   * frames after a stream arrives have no picture yet (`videoWidth` is 0 until
   * metadata lands), and a loop that returned on that would never come back.
   */
  load() {
    this.paintHandle = null;

    if (this.stream == null) {
      return;
    }

    const canvas = this.canvas;
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;

    if (canvas != null && width > 0 && height > 0) {
      // Assigning either dimension clears the canvas, so only do it when the
      // source actually changed size — otherwise every frame reallocates the
      // backing store.
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      const ctx = canvas.getContext("2d");
      ctx?.drawImage(this.video, 0, 0, width, height);
    }

    this.paintHandle = window.requestAnimationFrame(() => this.load());
  }

  /** Start the paint loop, unless it is already running. */
  private startPainting() {
    if (this.paintHandle == null) {
      this.load();
    }
  }

  private stopPainting() {
    if (this.paintHandle != null) {
      window.cancelAnimationFrame(this.paintHandle);
      this.paintHandle = null;
    }
  }

  /**
   * Show the selected screen.
   *
   * `getUserMedia` with `chromeMediaSourceId` rather than `getDisplayMedia`:
   * it captures the source the user picked, and it does so without a picker
   * dialog — which matters when the trigger is merely opening a panel.
   */
  async startPreview(sourceId?: string) {
    const wanted = sourceId ?? this.selectedValue ?? "";

    if (!wanted || this.isStartingPreview) {
      return;
    }
    if (this.stream != null && this.streamSourceId === wanted) {
      return;
    }

    this.isStartingPreview = true;

    // Release the old one first: two screen captures at once is a cost with no
    // benefit, and on some systems the second simply fails.
    this.releaseStream();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: wanted,
            maxWidth: 1920,
            maxHeight: 1080,
            // Capture at the rate the project runs at. A recording made at 60
            // for a 30fps timeline throws half its frames away at import, and
            // one made at 60 for a 120fps timeline can never fill it.
            maxFrameRate: projectFps(),
          },
        },
      } as any);

      // The panel may have been hidden while the permission round trip ran.
      if (controlPanelStore.getState().nowActive !== "record") {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      this.stream = stream;
      this.streamSourceId = wanted;
      this.previewError = "";

      // Ending the share from the OS chrome ends the track but tells the
      // component nothing, which used to leave it believing it was still
      // recording for the rest of the session.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (this.isRecord) {
          this.stop();
        } else {
          this.releaseStream();
          this.requestUpdate();
        }
      });

      this.video.srcObject = stream;
      await this.video.play().catch(() => {
        // A detached, muted element is allowed to autoplay; if a policy ever
        // says otherwise, the loop below simply paints nothing rather than
        // taking the panel down with it.
      });

      this.startPainting();
    } catch (error) {
      console.error("[record] could not preview the screen", error);
      this.previewError =
        "Could not show the screen. Check Screen Recording permission for Cartcut in System Settings → Privacy & Security.";
    } finally {
      this.isStartingPreview = false;
      this.requestUpdate();
    }
  }

  /** Drop the capture and the picture it was feeding. */
  private releaseStream() {
    this.stopPainting();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.streamSourceId = "";
    this.video.srcObject = null;
  }

  /**
   * Stop previewing — but never mid-recording.
   *
   * Switching to another panel while recording has to keep capturing: the
   * recorder is reading this very stream, and the user asked for a recording,
   * not for one that ends when they look away.
   */
  stopPreview() {
    if (this.isRecord) {
      return;
    }
    this.releaseStream();
    this.requestUpdate();
  }

  stop() {
    // Re-entrant: the stop button and the track's own `ended` both land here,
    // and `MediaRecorder.stop()` throws once the recorder is inactive.
    if (this.isRecord == false) {
      return;
    }

    this.isRecord = false;
    this.mediaRecorder?.stop();

    // The stream stays up — it is the preview, and the user is still looking
    // at the panel they just recorded from. It is released when they leave the
    // panel, or when the app closes.
    if (controlPanelStore.getState().nowActive !== "record") {
      this.releaseStream();
    }

    this.requestUpdate();
  }

  async startRecording() {
    try {
      // Record the picture on screen. Waiting for the preview here is what
      // guarantees the two are the same capture rather than two of them.
      if (this.stream == null) {
        await this.startPreview();
      }

      const stream = this.stream;
      if (stream == null) {
        return;
      }

      this.mediaRecorder = new MediaRecorder(stream);
      this.recordedChunks = [];
      this.startTime = Date.now();

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.recordedChunks, { type: "video/webm" });
        this.endTime = Date.now();

        const duration = this.endTime - this.startTime;
        const arrayBuffer = await blob.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        await saveAndImportRecording(buffer, "video", duration);

        this.recordedChunks = [];
        this.mediaRecorder = undefined;
        this.startTime = 0;
        this.endTime = 0;
        this.requestUpdate();
      };

      this.mediaRecorder.start();
      this.isRecord = true;
      // The preview loop is already running; this only covers the case where
      // the stream was acquired a moment ago by the call above.
      this.startPainting();
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

  connectedCallback() {
    super.connectedCallback();

    // `Control.ts` keeps this component mounted for the life of the app and
    // only toggles `d-none`, so being connected says nothing about being
    // looked at. The store does.
    this.unsubscribePanel = controlPanelStore.subscribe((state) => {
      if (state.nowActive === "record") {
        void this.enterPanel();
      } else {
        this.stopPreview();
      }
    });

    if (controlPanelStore.getState().nowActive === "record") {
      void this.enterPanel();
    }
  }

  disconnectedCallback() {
    this.unsubscribePanel?.();
    this.unsubscribePanel = undefined;
    // Not `stopPreview`: on teardown there is nothing left to record into.
    this.releaseStream();
    super.disconnectedCallback();
  }

  /** Panel became visible: make sure there is a source list and a picture. */
  private async enterPanel() {
    await this.loadSources();
    void this.startPreview();
  }

  /**
   * Read the screen list once.
   *
   * Deliberately not in `updated()`, where it used to sit: that runs on every
   * render, and the guard it used was set unconditionally afterwards, so a
   * failed first call could never be retried.
   */
  private async loadSources() {
    if (this.hasLoadedSources) {
      return;
    }

    try {
      const result = await window.electronAPI.req.desktopCapturer.getSources();

      if (!result || result.status == 0 || !result.sources?.length) {
        this.previewError = "No screens available to capture.";
        this.requestUpdate();
        return;
      }

      this.hasLoadedSources = true;
      this.screenSources = result.sources.map((source) => ({
        id: source.id,
        name: source.name,
      }));

      // Pick one so there is something to preview without the user choosing.
      if (!this.selectedValue) {
        this.selectedValue = this.screenSources[0].id;
        this.selectedText = this.screenSources[0].name;
      }

      this.requestUpdate();
    } catch (error) {
      console.error("[record] could not list screens", error);
      this.previewError = "Could not list the available screens.";
      this.requestUpdate();
    }
  }

  handleChangeSelect(event) {
    const selectElement = event.target;
    this.selectedValue = selectElement.value;
    this.selectedText = selectElement.options[selectElement.selectedIndex].text;

    // Switching source mid-recording would swap the picture out from under the
    // recorder, so the control is disabled then; this is belt and braces.
    if (!this.isRecord) {
      void this.startPreview(this.selectedValue);
    }
  }

  render() {
    const selectMap: any = [];

    for (let index = 0; index < this.screenSources.length; index++) {
      const element = this.screenSources[index] as any;
      selectMap.push(
        html`<option
          value="${element.id}"
          ?selected=${element.id === this.selectedValue}
        >
          ${element.name}
        </option>`,
      );
    }

    const isLive = this.stream != null;

    return html`
      <div
        class="d-flex"
        style="flex-direction: column;
    padding: 1rem;     justify-content: center;
    align-items: center;
    gap: 1rem;"
      >
        <div class="position-relative" style="width: 60%;">
          <canvas
            id="screenRecordCanvasRef"
            style="width: 100%; max-height: calc(${this
              .canvasMaxHeight}px - 40px); background-color: #0d0d0d; border-radius: 0.25rem;"
            width="1920"
            height="1080"
          ></canvas>

          ${isLive
            ? ""
            : html`<div
                class="position-absolute top-50 start-50 translate-middle text-secondary text-center"
                style="font-size: 0.8rem; width: 90%;"
              >
                ${this.previewError || "Starting the screen preview…"}
              </div>`}
        </div>

        <div class="d-flex col gap-2">
          <select
            class="form-select bg-dark text-light form-select-sm"
            aria-label="select screen"
            ?disabled=${this.isRecord}
            @change=${this.handleChangeSelect}
          >
            ${selectMap}
          </select>

          <button
            class="btn btn-primary ${this.isRecord ? "d-none" : ""}"
            ?disabled=${!isLive}
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

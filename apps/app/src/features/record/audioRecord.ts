/**
 * The audio-record panel: a microphone recorder, and a live waveform that says
 * it is running.
 *
 * A microphone recording shows nothing on screen the way a screen recording
 * does — the only feedback that the take is live, and that the OS handed us a
 * mic that actually carries signal, is the waveform. So the analyser is wired
 * to the *recorder's own stream*: what the bars draw is the samples being
 * written to the file, not a second capture that could be a different device.
 *
 * The bars are an amplitude history scrolling right to left, not an
 * oscilloscope of the current buffer. A recording is a thing with a length, and
 * the history is what makes a silent stretch visible as a silent stretch
 * seconds after it happened.
 */

import { LitElement, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { uiStore } from "../../states/uiStore";
import { Buffer } from "buffer";
import { saveAndImportRecording } from "./saveRecording";

/** Bars across the canvas — with the interval below, the visible history. */
const BAR_COUNT = 160;

/**
 * One bar per this many milliseconds.
 *
 * Sampled on a clock rather than once per animation frame: the scroll speed
 * has to be the same on a 120Hz display as on a 60Hz one, and the peak that
 * survives into a bar has to cover the whole interval rather than whichever
 * instant a frame landed on.
 */
const SAMPLE_MS = 33;

@customElement("audio-record-panel")
export class AudioRecordPanel extends LitElement {
  canvasMaxHeight: any;
  video: HTMLVideoElement;
  isRecord: boolean;
  mediaRecorder: MediaRecorder | any;
  recordedChunks: any;
  startTime: number;
  endTime: number;
  stream: MediaStream | any;

  /** The meter, live only while recording. */
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private timeData: Uint8Array | null = null;
  /** The paint loop's handle, so it is never started twice. */
  private waveHandle: number | null = null;
  /** Amplitude history, 0..1, oldest first. Always `BAR_COUNT` long. */
  private levels: number[] = [];
  /** Loudest sample seen since the last bar was pushed. */
  private peakSinceSample = 0;
  private lastSampleAt = 0;
  /** Elapsed-time label, redrawn only when the text changes. */
  private elapsedLabel = "00:00";
  private elapsedTimer: number | null = null;

  constructor() {
    super();

    this.canvasMaxHeight = "100%";
    this.video = document.createElement("video");
    this.isRecord = false;
    this.mediaRecorder = undefined;
    this.recordedChunks = undefined;
    this.startTime = 0;
    this.endTime = 0;
    this.levels = new Array(BAR_COUNT).fill(0);
  }

  @query("#audioRecordCanvasRef") canvas!: HTMLCanvasElement;

  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property()
  control = this.timelineState.control;

  stop() {
    // Re-entrant: `MediaRecorder.stop()` throws once the recorder is inactive,
    // and the button is one click away from being pressed twice.
    if (this.isRecord == false) {
      return;
    }

    this.isRecord = false;
    this.mediaRecorder?.stop();
    this.mediaRecorder = null;

    this.stopMetering();

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.requestUpdate();
  }

  async startRecording() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: true,
      });

      this.mediaRecorder = new MediaRecorder(this.stream);
      this.recordedChunks = [];
      this.startTime = Date.now();

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.recordedChunks, { type: "audio/wav" });
        this.endTime = Date.now();

        const duration = this.endTime - this.startTime;
        const arrayBuffer = await blob.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        await saveAndImportRecording(buffer, "audio", duration);

        this.recordedChunks = [];
        this.mediaRecorder = undefined;
        this.startTime = 0;
        this.endTime = 0;
        this.requestUpdate();
      };

      this.mediaRecorder.start();
      this.isRecord = true;
      this.startMetering(this.stream);
      this.requestUpdate();
    } catch (err) {
      console.error("Error starting screen recording:", err);
    }
  }

  /** Tap the stream being recorded, and start drawing what it carries. */
  private startMetering(stream: MediaStream) {
    this.stopMetering();

    try {
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      // A meter, not a spectrum: the smoothing constant only affects the
      // frequency data we never ask for, but the buffer size decides how much
      // of the interval one read covers.
      const sourceNode = audioContext.createMediaStreamSource(stream);
      sourceNode.connect(analyser);
      // Deliberately not connected to the destination — monitoring the mic
      // through the speakers is how a recording picks up its own feedback.

      this.audioContext = audioContext;
      this.analyser = analyser;
      this.sourceNode = sourceNode;
      this.timeData = new Uint8Array(analyser.fftSize);

      // An AudioContext created without a user gesture starts suspended; the
      // click that got us here is one, but resuming costs nothing either way.
      void audioContext.resume().catch(() => {});
    } catch (error) {
      // No meter is a worse panel, not a broken recording.
      console.error("[record] could not meter the microphone", error);
      return;
    }

    this.levels = new Array(BAR_COUNT).fill(0);
    this.peakSinceSample = 0;
    this.lastSampleAt = performance.now();
    this.elapsedLabel = "00:00";

    this.paint();

    this.elapsedTimer = window.setInterval(() => this.tickElapsed(), 250);
  }

  /** Drop the meter and everything it holds. The recording is unaffected. */
  private stopMetering() {
    if (this.waveHandle != null) {
      window.cancelAnimationFrame(this.waveHandle);
      this.waveHandle = null;
    }
    if (this.elapsedTimer != null) {
      window.clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }

    this.sourceNode?.disconnect();
    this.sourceNode = null;
    this.analyser = null;
    this.timeData = null;

    // Contexts are a limited resource per document, so one per take is closed
    // rather than kept.
    void this.audioContext?.close().catch(() => {});
    this.audioContext = null;

    this.levels = new Array(BAR_COUNT).fill(0);
    this.peakSinceSample = 0;
    this.elapsedLabel = "00:00";
    this.drawWave();
  }

  /**
   * Read the analyser once per frame, and turn it into bars on a clock.
   *
   * Every early return here stops the loop outright — unlike the screen
   * preview, there is nothing that arrives late: the analyser either exists,
   * in which case it already has samples, or metering is over.
   */
  private paint() {
    this.waveHandle = null;

    const analyser = this.analyser;
    const timeData = this.timeData;
    if (analyser == null || timeData == null) {
      return;
    }

    analyser.getByteTimeDomainData(timeData as any);

    // Peak rather than RMS: what the bar has to answer is "is the signal
    // there", and a peak says so on the first syllable.
    let peak = 0;
    for (let i = 0; i < timeData.length; i++) {
      const value = Math.abs(timeData[i] - 128) / 128;
      if (value > peak) {
        peak = value;
      }
    }
    if (peak > this.peakSinceSample) {
      this.peakSinceSample = peak;
    }

    const now = performance.now();
    // A loop, so a dropped frame scrolls by the time it actually cost rather
    // than by one bar — capped, so a backgrounded panel does not return and
    // redraw the entire history in one frame.
    let pushed = 0;
    while (now - this.lastSampleAt >= SAMPLE_MS && pushed < BAR_COUNT) {
      this.levels.push(this.peakSinceSample);
      this.levels.shift();
      this.peakSinceSample = 0;
      this.lastSampleAt += SAMPLE_MS;
      pushed++;
    }
    if (pushed >= BAR_COUNT) {
      this.lastSampleAt = now;
    }

    this.drawWave();

    this.waveHandle = window.requestAnimationFrame(() => this.paint());
  }

  /**
   * Draw the history, newest at the right.
   *
   * The backing store is sized in device pixels from the laid-out width: the
   * canvas is stretched to the panel by CSS, and a 1× backing store behind a 2×
   * display is the one thing that makes a waveform look cheap.
   */
  private drawWave() {
    const canvas = this.canvas;
    if (canvas == null) {
      return;
    }

    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    // The panel lives under `d-none` when another one is showing, and a hidden
    // element lays out at zero. Nothing to draw, and no size to draw it at.
    if (cssWidth <= 0 || cssHeight <= 0) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(cssWidth * dpr);
    const height = Math.round(cssHeight * dpr);

    // Assigning either dimension clears the canvas, so only do it on a real
    // change — otherwise every frame reallocates the backing store.
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext("2d");
    if (ctx == null) {
      return;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const mid = height / 2;

    // The zero line, so an idle panel still reads as a waveform view rather
    // than as an empty box.
    ctx.fillStyle = "#2b2b2b";
    ctx.fillRect(0, Math.round(mid), width, Math.max(1, Math.round(dpr)));

    const slot = width / BAR_COUNT;
    const barWidth = Math.max(1, Math.floor(slot * 0.6));
    // Half the height, less a margin, and mirrored — so a full-scale bar
    // reaches the edge and clipping is visible as clipping.
    const maxBar = mid - 4 * dpr;

    ctx.fillStyle = this.isRecord ? "#dc3545" : "#3d3d3d";

    for (let i = 0; i < BAR_COUNT; i++) {
      const level = this.levels[i];
      if (level <= 0) {
        continue;
      }

      const barHeight = Math.max(dpr, level * maxBar);
      const x = Math.round(i * slot + (slot - barWidth) / 2);
      ctx.fillRect(x, mid - barHeight, barWidth, barHeight * 2);
    }
  }

  /** Update the elapsed label, and re-render only when it actually changed. */
  private tickElapsed() {
    if (this.isRecord == false || this.startTime == 0) {
      return;
    }

    const elapsed = Math.max(0, Date.now() - this.startTime);
    const totalSeconds = Math.floor(elapsed / 1000);
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    const label = `${minutes}:${seconds}`;

    if (label !== this.elapsedLabel) {
      this.elapsedLabel = label;
      this.requestUpdate();
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

  disconnectedCallback() {
    this.stopMetering();
    super.disconnectedCallback();
  }

  /**
   * Draw the idle baseline once the canvas is laid out.
   *
   * The paint loop only runs while recording, so without this the panel is an
   * empty box until the first take. It is also what picks up a resize, since a
   * re-render is the one thing that follows the layout changing.
   */
  updated() {
    this.drawWave();
  }

  render() {
    // A custom element is inline by default, so the host shrinks to its
    // content — and this panel's content is a canvas with no width attribute,
    // whose intrinsic 300px was the whole width the waveform ever got. The
    // screen panel gets away without this only because its canvas carries
    // `width="1920"`.
    this.style.width = "100%";

    return html`
      <div
        class="d-flex"
        style="flex-direction: column;
    padding: 1rem;     justify-content: center;
    align-items: center;
    gap: 1rem; width: 100%;"
      >
        <div
          class="position-relative"
          style="width: 100%; max-width: 40rem;"
        >
          <canvas
            id="audioRecordCanvasRef"
            style="width: 100%; height: 120px; background-color: #0d0d0d; border-radius: 0.25rem;"
          ></canvas>

          ${this.isRecord
            ? html`<div
                class="position-absolute d-flex align-items-center gap-2"
                style="top: 0.5rem; left: 0.75rem; font-size: 0.8rem;"
              >
                <span
                  style="width: 0.5rem; height: 0.5rem; border-radius: 50%; background-color: #dc3545;"
                ></span>
                <span class="text-light font-monospace"
                  >${this.elapsedLabel}</span
                >
              </div>`
            : html`<div
                class="position-absolute top-50 start-50 translate-middle text-secondary text-center"
                style="font-size: 0.8rem; width: 90%;"
              >
                Press record to capture the microphone.
              </div>`}
        </div>

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
    `;
  }
}

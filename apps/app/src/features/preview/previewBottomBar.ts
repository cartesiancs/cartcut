import { LitElement, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import {
  IPreviewViewportStore,
  previewViewportStore,
} from "../../states/previewViewportStore";
import {
  IRenderOptionStore,
  renderOptionStore,
} from "../../states/renderOptionStore";
import { playbackPreviewStore } from "../../states/playbackPreviewStore";
import { previewMuteStore } from "../../states/previewMuteStore";
import { sharedAudioPeakProvider } from "../timeline/strip/audioPeaks";
import {
  audiblePathsAt,
  compositeLevel,
  meterFractionOf,
  amplitudeToDb,
} from "../timeline/audioLevel";
import {
  SILENT,
  advanceMeter,
  isMoving,
  silentAt,
  type MeterState,
} from "./meterBallistics";

/**
 * The strip under the preview: what is being heard, a way to stop hearing it,
 * and a way to watch.
 *
 * The mirror of `preview-top-bar` (same 2rem height, same light DOM, same
 * inline `<style>` in `render()`, same `_toolbar.scss` controls) so the preview
 * column reads as one thing bracketed top and bottom rather than as a canvas
 * with two unrelated toolbars stuck to it.
 *
 * **Almost nothing lives here.** The level is `timeline/audioLevel.ts`, the
 * ballistics are `meterBallistics.ts`, the mode transition is
 * `playbackPreview.ts`, the mute is `outputMute.ts`; all four are pure and
 * have suites. What is left is a store subscription, a `requestAnimationFrame`
 * loop and a canvas, which is the most that can be left: this repo has no DOM
 * test environment
 * (`vitest.config.ts` is `environment: "node"`, and nothing installs jsdom), so
 * logic left in a Lit component is logic that cannot be tested at all.
 * `features/asset/assetHover.ts` states the same rule at greater length.
 */

/**
 * Segments, left to right, and what each one is worth.
 *
 * A segmented meter quantises the scale, and the quantisation is the feature: a
 * continuous bar invites reading a position, which a peak meter cannot support,
 * while six lit-or-not blocks say only "about this loud" — which is all the
 * measurement is good for.
 *
 * Six over the 60 dB scale is 10 dB a block, and the colours sit where a
 * hardware meter puts them: the last block is the one you are not meant to
 * reach.
 */
const SEGMENTS = 6;
const SEGMENT_COLORS = [
  "#5ba85f",
  "#5ba85f",
  "#5ba85f",
  "#5ba85f",
  "#d98b2b",
  "#c74a3f",
];

/** Unlit. Drawn rather than left blank, so a silent meter still reads as one. */
const SEGMENT_DARK = "#2f3338";

@customElement("preview-bottom-bar")
export class PreviewBottomBar extends LitElement {
  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property()
  timeline: any = this.timelineState.timeline;

  @property()
  timelineCursor = this.timelineState.cursor;

  @property()
  isPlay = this.timelineState.control.isPlay;

  @property()
  viewportStore: IPreviewViewportStore = previewViewportStore.getInitialState();

  @property()
  renderOptionStore: IRenderOptionStore = renderOptionStore.getInitialState();

  @property()
  renderOption = this.renderOptionStore.options;

  @property()
  isPlaybackPreview =
    playbackPreviewStore.getInitialState().state.active;

  @property()
  muted = previewMuteStore.getInitialState().muted;

  @query("#previewMeterCanvas")
  private canvas!: HTMLCanvasElement | null;

  private peaks = sharedAudioPeakProvider();
  private meter: MeterState = SILENT;
  private meterHandle = 0;

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
      this.timelineCursor = state.cursor;

      if (state.control.isPlay !== this.isPlay) {
        this.isPlay = state.control.isPlay;
      }
      // Woken on every cursor tick as well as on play/stop: starting the loop
      // is idempotent, and the tick is what lets the meter come back up when
      // playback resumes from a paused position rather than waiting a frame.
      this.wakeMeter();
    });

    renderOptionStore.subscribe((state) => {
      this.renderOption = state.options;
    });

    playbackPreviewStore.subscribe((state) => {
      this.isPlaybackPreview = state.state.active;
      this.requestUpdate();
    });

    previewMuteStore.subscribe((state) => {
      this.muted = state.muted;
      // So a meter that was showing signal falls the moment the sound stops,
      // rather than freezing lit until the next cursor tick.
      this.wakeMeter();
    });

    return this;
  }

  protected firstUpdated(): void {
    this.drawMeter();
  }

  disconnectedCallback(): void {
    if (this.meterHandle !== 0) {
      cancelAnimationFrame(this.meterHandle);
      this.meterHandle = 0;
    }
    super.disconnectedCallback();
  }

  /**
   * The project resolution, coerced — the settings inputs hand out strings.
   *
   * Same guard `previewCanvas.frameSize` applies, and for the same reason: a
   * zero or a `NaN` here would put the presentation viewport's centre at
   * `NaN` and blank the preview.
   */
  private get frameSize() {
    const w = Number(this.renderOption.previewSize.w);
    const h = Number(this.renderOption.previewSize.h);
    return { w: w > 0 ? w : 1, h: h > 0 ? h : 1 };
  }

  private _handleClickPlaybackPreview() {
    const viewport = playbackPreviewStore
      .getState()
      .toggle(
        previewViewportStore.getState().viewport,
        this.frameSize.w,
        this.frameSize.h,
      );

    previewViewportStore.getState().setViewport(viewport);
  }

  private _handleClickMute() {
    previewMuteStore.getState().toggle();
  }

  /** Start the meter loop if it is not already running. */
  private wakeMeter() {
    if (this.meterHandle !== 0) {
      return;
    }
    this.meterHandle = requestAnimationFrame(() => this.tickMeter());
  }

  /**
   * One meter frame.
   *
   * The target is the composite level **while playing and zero otherwise**,
   * because that is what is actually leaving the speakers: `intentFor` gives a
   * handle `playing: isPlaying && inWindow`, so a scrub moves the playhead over
   * a clip without sounding it. A meter that lit up under a silent scrub would
   * be reporting on the document rather than on the output. Muted counts as
   * not playing for the same reason.
   *
   * The loop stops itself once the bar has finished falling. An exponential
   * decay never reaches zero, so `isMoving`'s floor is what keeps a stopped
   * project from holding a `requestAnimationFrame` open for the session.
   */
  private tickMeter() {
    this.meterHandle = 0;

    const now = performance.now();
    let target = 0;

    if (this.isPlay && !this.muted) {
      // Ask for whatever is not decoded yet. Without this the meter would only
      // know about files the *timeline* happened to have drawn, so a project
      // scrolled away from the playhead would meter as silence.
      for (const localpath of audiblePathsAt(
        this.timeline,
        this.timelineCursor,
      )) {
        this.peaks.request(localpath);
      }

      target = compositeLevel(this.timeline, this.timelineCursor, (path) =>
        this.peaks.get(path),
      );
    }

    const next = advanceMeter(this.meter, target, now);
    if (next !== this.meter) {
      this.meter = next;
      this.drawMeter();
    }

    if (this.isPlay || isMoving(this.meter)) {
      this.meterHandle = requestAnimationFrame(() => this.tickMeter());
      return;
    }

    // Park the clock at the moment we stopped, so the next wake measures its
    // decay from now rather than from however long the project sat paused.
    this.meter = silentAt(now);
    this.drawMeter();
  }

  /**
   * Draw the bar.
   *
   * Backing store sized in device pixels from the laid-out width, the way
   * `audioRecord.drawWave` does it: this canvas is stretched by CSS, and a 1×
   * store behind a 2× display is what makes a meter look cheap.
   */
  private drawMeter() {
    const canvas = this.canvas;
    if (canvas == null) {
      return;
    }

    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    // The whole column lays out at zero while another preview tab is showing.
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

    const level = meterFractionOf(amplitudeToDb(this.meter.level));
    const hold = meterFractionOf(amplitudeToDb(this.meter.hold));

    // The block the peak marker sits in. A segmented meter has nowhere to put a
    // line between blocks, so the marker *is* a block, lit on its own past the
    // signal, which is the hardware idiom and needs no extra colour.
    const holdIndex =
      hold > 0 ? Math.min(SEGMENTS - 1, Math.floor(hold * SEGMENTS)) : -1;

    // The gaps are whole device pixels and only the cells absorb the rounding.
    // A cell's right edge and the next one's left edge are rounded from two
    // values exactly `gap` apart, and rounding keeps a whole-number difference,
    // so every gap comes out `gap` wide and the cells differ by at most a
    // pixel: six blocks differing by a pixel reads as six blocks, while one gap
    // of 1px among 2px gaps reads as a mistake.
    const gap = Math.max(1, Math.round(dpr));
    const cell = (width - gap * (SEGMENTS - 1)) / SEGMENTS;
    const radius = Math.max(1, Math.round(dpr));

    for (let i = 0; i < SEGMENTS; i++) {
      // i counts from the left, the direction the meter fills.
      const left = Math.round(i * (cell + gap));
      const right = Math.round(i * (cell + gap) + cell);
      const lit = level * SEGMENTS > i || i === holdIndex;

      ctx.fillStyle = lit ? SEGMENT_COLORS[i] : SEGMENT_DARK;
      ctx.beginPath();
      ctx.roundRect(left, 0, Math.max(1, right - left), height, radius);
      ctx.fill();
    }
  }

  render() {
    return html`
      <style>
        .preview-bottom-bar {
          display: flex;
          flex-direction: row;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          height: 2rem;
          /* Mirrors the top bar's border-bottom, so the preview sits inside a
             pair of hairlines rather than under one. */
          border-top: 0.05rem #3a3f44 solid;
          padding: 0 0.4rem;
        }
      </style>

      <div class="preview-bottom-bar bg-darker">
        <!--
          No label and no dB read-out. This is a comparison at a glance (is
          there signal, is it clipping) and a number beside it invites reading
          a peak meter as a loudness measurement, which it is not.

          The meter is the mute because it is where the sound is: a speaker
          glyph somewhere else on the bar would be a second place to look for
          one fact. data-keeps-selection, because muting is not a reason to
          lose the clip being worked on.
        -->
        <button
          type="button"
          class="tb-level"
          title=${this.muted ? "Unmute preview" : "Mute preview"}
          aria-label=${this.muted ? "Unmute preview" : "Mute preview"}
          aria-pressed=${this.muted ? "true" : "false"}
          data-keeps-selection
          @click=${this._handleClickMute}
        >
          <span class="material-symbols-outlined"
            >${this.muted ? "volume_off" : "volume_up"}</span
          >
          <canvas id="previewMeterCanvas" class="tb-level-meter"></canvas>
        </button>

        <div class="tb-group">
          <!--
            The only way out of the playback preview, which is why the bar is
            excluded from that mode's pointer-events block in style.scss. A
            mode that swallows every click on the screen has to carry its own
            exit; the screen recorder's drawing mode learned this the hard way.
          -->
          <button
            type="button"
            @click=${this._handleClickPlaybackPreview}
            class="tb-btn is-framed ${this.isPlaybackPreview ? "is-on" : ""}"
            title="Playback preview"
            aria-label="Playback preview"
            aria-pressed=${this.isPlaybackPreview ? "true" : "false"}
          >
            <span class="material-symbols-outlined">slideshow</span>
          </button>
        </div>
      </div>
    `;
  }
}

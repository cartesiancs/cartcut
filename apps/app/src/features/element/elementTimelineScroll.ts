import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { IUIStore, uiStore } from "../../states/uiStore";
import {
  IRenderOptionStore,
  renderOptionStore,
} from "../../states/renderOptionStore";
import { maxTimelineScroll } from "../../utils/time";

@customElement("element-timeline-bottom-scroll")
export class ElementTimelineBottomScroll extends LitElement {
  @property({ attribute: false })
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property({ attribute: false })
  timelineRange = this.timelineState.range;

  @property({ attribute: false })
  timelineScroll = this.timelineState.scroll;

  @property({ attribute: false })
  uiState: IUIStore = uiStore.getInitialState();

  @property({ attribute: false })
  renderOptionStore: IRenderOptionStore = renderOptionStore.getInitialState();

  @property({ attribute: false })
  renderOption = this.renderOptionStore.options;

  @property({ attribute: false })
  resize = this.uiState.resize;
  isMove: boolean;
  left: number;
  width: number;
  mouseLeft: number;
  prevLeft: number;
  isScrollable: boolean;

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timelineRange = state.range;
      this.timelineScroll = state.scroll;

      // The bar is not in the DOM while the whole project fits on screen, so
      // both lookups can miss. Nothing to position in that case.
      const track = document.querySelector(
        ".timeline-bottom-scroll",
      ) as HTMLElement | null;
      const thumb = document.querySelector(
        ".timeline-bottom-scroll-thumb",
      ) as HTMLElement | null;

      if (track && thumb) {
        const fullWidth =
          track.offsetWidth - this.resize.timelineVertical.leftOption;

        this.left = this.travelOf(fullWidth - thumb.offsetWidth) * this.ratio();

        if (!this.isMove) {
          this.prevLeft = this.left;
        }
      }

      this.requestUpdate();
    });

    uiStore.subscribe((state) => {
      this.resize = state.resize;
      this.requestUpdate();
    });

    renderOptionStore.subscribe((state) => {
      this.renderOption = state.options;
      this.requestUpdate();
    });

    return this;
  }

  constructor() {
    super();
    this.isMove = false;
    this.mouseLeft = 0;
    this.left = 0;
    this.prevLeft = 0;
    this.width = 100;
    this.isScrollable = true;

    document.addEventListener("mousemove", this._handleMouseMove.bind(this));
    document.addEventListener("mouseup", this._handleMouseUp.bind(this));
  }

  render() {
    this.setWidth();

    // The whole range is on screen — there is nothing left to scroll to, so
    // the bar goes away rather than sitting there inert.
    if (!this.isScrollable) {
      return html``;
    }

    return html` <style>
        .timeline-bottom-scroll {
          width: 100%;
          height: 10px;
          background-color: #181a1cb5;
          backdrop-filter: blur(8px);
          position: fixed;
          bottom: 20px;
          left: ${this.resize.timelineVertical.leftOption}px;
          cursor: pointer;
        }

        .timeline-bottom-scroll-thumb {
          width: 20px;
          height: 10px;
          position: relative;
          background-color: #202225;
          backdrop-filter: blur(8px);
          position: fixed;
          bottom: 0;

          cursor: pointer;
        }
      </style>

      <div
        class="timeline-bottom-scroll"
        @mousedown=${this._handleMouseBodyDown}
      >
        <div
          @mousedown=${this._handleClickThumb}
          class="timeline-bottom-scroll-thumb"
          style="left: ${this.left}px; width: ${this.width}%;"
        ></div>
      </div>`;
  }

  setWidth() {
    try {
      const timelineCanvas = document.querySelector(
        "#elementTimelineCanvasRef",
      ) as HTMLElement;

      const projectDuration = this.renderOption.duration;
      const timelineRange = this.timelineRange;
      const timeMagnification = timelineRange / 4;

      const end = ((projectDuration * 1000) / 5) * timeMagnification;

      const width = 100 / (end / timelineCanvas.offsetWidth);

      // width >= 100 means the thumb would be as wide as its track: the whole
      // project is already visible. Not a rounding tolerance — half a pixel of
      // hidden timeline is not worth a scrollbar.
      this.isScrollable = Number.isFinite(width) && width < 99.5;
      this.width = Math.min(width, 100);
    } catch (error) {
      this.isScrollable = false;
    }
  }

  _handleMouseUp(e) {
    this.prevLeft = this.left;
    this.isMove = false;
  }

  _handleMouseMove(e) {
    if (!this.isMove) return false;

    // Zooming out mid-drag can take the bar out of the DOM under the pointer.
    const track = document.querySelector(
      ".timeline-bottom-scroll",
    ) as HTMLElement | null;
    const thumb = document.querySelector(
      ".timeline-bottom-scroll-thumb",
    ) as HTMLElement | null;

    if (!track || !thumb) {
      this.isMove = false;
      return false;
    }

    const fullWidth =
      track.offsetWidth - this.resize.timelineVertical.leftOption;

    const dx =
      e.clientX - this.resize.timelineVertical.leftOption - this.mouseLeft;

    // Clamped to the track before it becomes a scroll offset, so a pointer
    // dragged past either end stops the thumb instead of carrying the timeline
    // with it. Releasing there and dragging back responds immediately, because
    // `prevLeft` follows the clamped position rather than the pointer.
    const travel = this.travelOf(fullWidth - thumb.offsetWidth);
    const x = Math.min(Math.max(0, this.prevLeft + dx), travel);

    this.timelineState.setScroll(
      Math.round(this.maxScroll() * (travel > 0 ? x / travel : 0)),
    );
  }

  /** How far the thumb may travel, never negative. */
  private travelOf(span: number): number {
    return Math.max(0, span);
  }

  /** The largest scroll this project admits at the current zoom. */
  private maxScroll(): number {
    return maxTimelineScroll(
      this.renderOption.duration * 1000,
      this.timelineRange,
      useTimelineStore.getState().canvasWidth,
    );
  }

  /** Where the current scroll sits in `0..1` of its own range. */
  private ratio(): number {
    const max = this.maxScroll();
    if (max <= 0) {
      return 0;
    }
    return Math.min(1, Math.max(0, this.timelineScroll / max));
  }

  _handleMouseBodyDown(e) {
    if (e.target.className == "timeline-bottom-scroll") {
      this.mouseLeft = e.clientX - this.resize.timelineVertical.leftOption;
      this.isMove = true;

      // const scroll = millisecondsToPx(
      //   this.renderOption.duration * (per / 100) * 1000,
      //   this.timelineRange,
      // );

      // this.timelineState.setScroll(scroll);
    }
  }

  _handleClickThumb(e) {
    console.log(e.clientX - this.resize.timelineVertical.leftOption);
    this.mouseLeft = e.clientX - this.resize.timelineVertical.leftOption;
    this.isMove = true;
  }
}

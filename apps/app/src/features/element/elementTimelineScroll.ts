import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { IUIStore, uiStore } from "../../states/uiStore";
import {
  IRenderOptionStore,
  renderOptionStore,
} from "../../states/renderOptionStore";
import { millisecondsToPx, pxToMilliseconds } from "../../utils/time";

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

      const scrollMs = pxToMilliseconds(state.scroll, state.range);
      const per = (scrollMs / (this.renderOption.duration * 1000)) * 100;

      // The bar is not in the DOM while the whole project fits on screen, so
      // both lookups can miss. Nothing to position in that case.
      const track = document.querySelector<HTMLElement>(
        ".timeline-bottom-scroll",
      );
      const thumb = document.querySelector<HTMLElement>(
        ".timeline-bottom-scroll-thumb",
      );

      if (track && thumb) {
        const fullWidth =
          track.offsetWidth - this.resize.timelineVertical.leftOption;

        this.left = Math.max(0, (fullWidth - thumb.offsetWidth) * (per / 100));

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
      const timelineCanvas = document.querySelector<HTMLElement>(
        "#elementTimelineCanvasRef",
      );

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
    const track = document.querySelector<HTMLElement>(".timeline-bottom-scroll");
    const thumb = document.querySelector<HTMLElement>(
      ".timeline-bottom-scroll-thumb",
    );

    if (!track || !thumb) {
      this.isMove = false;
      return false;
    }

    const fullWidth =
      track.offsetWidth - this.resize.timelineVertical.leftOption;

    const thumbWidth = thumb.offsetWidth;
    const dx =
      e.clientX - this.resize.timelineVertical.leftOption - this.mouseLeft;

    const x = this.prevLeft + dx;

    const per = (x / (fullWidth - thumbWidth)) * 100;

    if (x <= 0) {
      this.left = 0;
      this.requestUpdate();
      this.timelineState.setScroll(0);
      return false;
    }

    // this.left = x;

    const scroll = millisecondsToPx(
      this.renderOption.duration * (per / 100) * 1000,
      this.timelineRange,
    );

    this.timelineState.setScroll(scroll);
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

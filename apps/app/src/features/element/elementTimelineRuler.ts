import { v4 as uuidv4 } from "uuid";
import { elementUtils } from "../../utils/element.js";
import { LitElement, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { IUIStore, uiStore } from "../../states/uiStore";
import {
  IRenderOptionStore,
  renderOptionStore,
} from "../../states/renderOptionStore";
import { msToPxSigned, pxToMsSigned } from "../timeline/geometry";
import { normalizeFps, snapMsToFrame } from "../timeline/frames";
import { planRulerTicks } from "../timeline/rulerTicks";
import { LABEL_FONT } from "../timeline/draw";
import { applySurface, surfaceSpec } from "../timeline/canvasSurface";
import { count as perfCount } from "../debug/frameStats";

@customElement("element-timeline-ruler")
export class ElementTimelineRuler extends LitElement {
  @query("#elementTimelineRulerCanvasRef") canvas!: HTMLCanvasElement;

  mousemoveEventHandler: any;
  mouseTimeout: any;
  rulerType: string;
  resizeInterval: string | number | undefined;
  width: any;
  height: number | undefined;
  constructor() {
    super();
    this.mousemoveEventHandler = undefined;
    this.mouseTimeout = undefined;
    this.rulerType = "sec";
    this.addEventListener("mousedown", this.handleMousedown);
    document.addEventListener("mouseup", this.handleMouseup.bind(this));
  }

  @property({ attribute: false })
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  // Deliberately *not* reactive properties. Nothing in `render()` reads them —
  // the template is a bare `<canvas>` sized from the ui store — so a Lit update
  // could only re-emit identical markup and then repaint through `updated()`,
  // which is the second of the two paints per cursor tick. They are read by
  // `paintRuler`, which the store subscriber schedules directly.
  timelineRange = this.timelineState.range;

  timelineScroll = this.timelineState.scroll;

  timelineCursor = this.timelineState.cursor;

  @property({ attribute: false })
  renderOptionStore: IRenderOptionStore = renderOptionStore.getInitialState();

  @property({ attribute: false })
  renderOption = this.renderOptionStore.options;

  @property({ attribute: false })
  uiState: IUIStore = uiStore.getInitialState();

  @property({ attribute: false })
  resize = this.uiState.resize;

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timelineScroll = state.scroll;
      this.timelineCursor = state.cursor;
      this.timelineRange = state.range;
      this.drawRuler();
    });

    uiStore.subscribe((state) => {
      this.resize = state.resize;
    });

    renderOptionStore.subscribe((state) => {
      this.renderOption = state.options;
      this.drawRuler();
    });

    return this;
  }

  render() {
    this.classList.add("ps-0", "overflow-hidden", "position-absolute");
    this.style.top = "40px";
    this.style.left = `${this.resize.timelineVertical.leftOption}px`;

    this.style.position = "absolute";
    // The ruler is rendered ahead of <element-timeline> in the parent template,
    // so on the very first pass there may be nothing to measure yet.
    this.width = document.querySelector("element-timeline")?.clientWidth ?? 0;
    this.height = 30;

    return html`<canvas
      id="elementTimelineRulerCanvasRef"
      width="${this.width}"
      height="${this.height}"
      style="width: ${this.width}px; height: ${this.height}px;"
    ></canvas>`;
  }

  updated() {
    this.drawRuler();
  }

  private timelineResizeObserver?: ResizeObserver;

  /**
   * Redraw whenever the timeline is actually sized.
   *
   * `updated()` runs before the split pane has necessarily laid out, so the
   * first ruler could be measured at zero width and stay blank — taking the
   * playhead head drawn on it along too — until some later event repainted it.
   */
  protected firstUpdated(): void {
    const timeline = document.querySelector("element-timeline");
    if (timeline) {
      this.timelineResizeObserver = new ResizeObserver(() => this.drawRuler());
      this.timelineResizeObserver.observe(timeline);
    }

    this.drawRuler();
  }

  disconnectedCallback(): void {
    this.timelineResizeObserver?.disconnect();
    this.timelineResizeObserver = undefined;
    if (this.drawRequest) {
      cancelAnimationFrame(this.drawRequest);
      this.drawRequest = 0;
    }
    super.disconnectedCallback();
  }

  /**
   * The project's frame rate, from the one store that holds it.
   */
  private projectFps(): number {
    return normalizeFps(this.renderOption?.fps);
  }

  /**
   * Private copies of the px/ms conversion used to live here, rounding and
   * clamping in ways the clip canvas did not. They are gone: both now call the
   * shared `geometry` functions, so the ruler and the clips beneath it cannot
   * disagree about where a time is.
   */
  private millisecondsToPx(ms) {
    return msToPxSigned(ms, this.timelineRange);
  }



  drawCursorHead() {
    const ctx: any = this.canvas.getContext("2d");

    const now =
      this.millisecondsToPx(this.timelineCursor) - this.timelineScroll + 1;

    const size = 6;
    const top = 16;

    ctx.fillStyle = "#dbdaf0";

    ctx.beginPath();
    ctx.moveTo(now - size, top);
    ctx.lineTo(now, this.canvas.height);
    ctx.lineTo(now + size, top);
    ctx.lineWidth = 2;
    ctx.fill();
  }

  /** A pending coalesced repaint, or 0. */
  private drawRequest = 0;

  /**
   * Ask for a repaint on the next frame.
   *
   * The ruler was the worst offender of the four canvases: the store
   * subscriber drew it *and* wrote `timelineCursor`, which was a reactive
   * property, so Lit re-rendered the host and `updated()` drew it a second
   * time — twice per cursor tick, each one re-measuring the timeline through
   * `querySelector` + `clientWidth`, to move a six-pixel playhead triangle.
   * Those three fields are plain now, and this collapses whatever is left into
   * one paint per frame.
   */
  drawRuler() {
    if (this.drawRequest) {
      return;
    }
    this.drawRequest = requestAnimationFrame(() => {
      this.drawRequest = 0;
      this.paintRuler();
    });
  }

  private paintRuler() {
    perfCount("ruler.draw");
    const timeline = document.querySelector("element-timeline");
    if (!this.canvas || !timeline) return;

    this.width = timeline.clientWidth;

    const ctx = this.canvas.getContext("2d");
    if (ctx == null) return;

    // Through the shared surface helper, which writes the attributes only when
    // they actually change — assigning `canvas.width` reallocates and clears
    // the backing store even when the value is identical, and this ran on every
    // cursor tick. It also uses `setTransform` rather than `scale`, which is
    // what makes skipping the reallocation safe: `scale` compounds against
    // whatever transform survived, and only the reset hid that before.
    applySurface(
      this.canvas,
      ctx,
      surfaceSpec(this.width, this.height as number, window.devicePixelRatio),
    );

    // No longer implied by the resize, so it is explicit. In CSS pixels, since
    // the transform is already applied.
    ctx.clearRect(0, 0, this.width, this.height as number);

    const plan = planRulerTicks({
      range: this.timelineRange,
      hScroll: this.timelineScroll,
      width: this.width,
      fps: this.projectFps(),
    });

    ctx.strokeStyle = "#e3e3e3";
    ctx.lineWidth = 1;
    ctx.font = LABEL_FONT;

    for (const tick of plan.ticks) {
      ctx.beginPath();
      // Labelled ticks are taller, as they always were.
      ctx.moveTo(tick.x, tick.major ? 10 : 15);
      ctx.lineTo(tick.x, 20);
      ctx.stroke();

      if (tick.label != null) {
        // Just right of its own tick. The old ruler drew the text half a tick
        // to the *left*, which only lined up because every tick was the same
        // width; with a ladder that runs from one frame to a day it would drift
        // away from the mark it names.
        ctx.strokeText(tick.label, tick.x + 3, 10);
      }
    }

    this.drawCursorHead();
  }

  addTickNumber(licount) {
    // let addedli = '<li></li>'.repeat(licount)
    // this.querySelector("ul").innerHTML = addedli
  }

  // updateRulerLength(e) {
  //   this.updateTimelineEnd();
  // }

  // NOTE: timeline duration 이거 변경.
  // updateTimelineEnd() {
  //   const elementTimelineEnd = document.querySelector("element-timeline-end");
  //   const projectDuration = document.querySelector("#projectDuration").value;

  //   const timelineRange = this.timelineRange;
  //   const timeMagnification = timelineRange / 4;

  //   elementTimelineEnd.setEndTimeline({
  //     px: ((projectDuration * 1000) / 5) * timeMagnification,
  //   });
  // }

  changeWidth(px) {
    this.style.width = `${px}px`;
  }

  setTopPosition(px) {
    //this.style.top = `${px}px`
  }

  moveTime(e) {
    const elementTimeline = document.querySelector("element-timeline");
    const elementControl = document.querySelector("element-control");
    const cursorDom = document.querySelector("element-timeline-cursor");

    elementControl.progress = e.pageX + this.timelineScroll;

    elementControl.stop();
    this.timelineState.setPlay(false);

    cursorDom.style.left = `${e.pageX}px`;
  }

  pxToMilliseconds(px) {
    return pxToMsSigned(px, this.timelineRange);
  }

  handleMousemove(e) {
    const elementTimeline = document.querySelector("element-timeline");
    const elementControl = document.querySelector("element-control");
    const cursorDom = document.querySelector("element-timeline-cursor");

    // Scrubbing lands on a frame, so the frame the preview shows is the frame
    // the exporter will write. `elementControl.step` does the same for playback
    // now, through `playbackClock.ts` — with a floor rather than this round,
    // because a clock names the frame it is inside and a scrub names the frame
    // it is aiming at.
    this.timelineState.setCursor(
      snapMsToFrame(
        this.pxToMilliseconds(
          e.pageX +
            this.timelineScroll -
            this.resize.timelineVertical.leftOption,
        ),
        this.projectFps(),
      ),
    );

    cursorDom.style.left = `${
      e.pageX + this.timelineScroll - this.resize.timelineVertical.leftOption
    }px`;

    this.moveTime(e);

    clearTimeout(this.mouseTimeout);

    this.mouseTimeout = setTimeout(() => {
      clearInterval(this.resizeInterval);
      this.moveTime(e);
    }, 100);
  }

  handleMousedown(e) {
    e.stopPropagation();
    this.mousemoveEventHandler = this.handleMousemove.bind(this);
    document.addEventListener("mousemove", this.mousemoveEventHandler);
    this.handleMousemove(e);
  }

  handleMouseup(e) {
    document.removeEventListener("mousemove", this.mousemoveEventHandler);
    document.removeEventListener("click", this.mousemoveEventHandler);
  }
}

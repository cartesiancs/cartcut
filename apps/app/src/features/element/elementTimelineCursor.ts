import { v4 as uuidv4 } from "uuid";
import { elementUtils } from "../../utils/element.js";
import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";

/**
 * Playhead position holder.
 *
 * This element is deliberately never shown. The playhead the user sees is
 * painted on canvas — the vertical line by `element-timeline-canvas.drawCursor`
 * and the triangular head by `element-timeline-ruler.drawCursorHead` — and this
 * element survives only because `element-control` still reads its `style.left`
 * as the current playhead position. Un-hiding it would draw a second playhead.
 */
@customElement("element-timeline-cursor")
export class ElementTimelineCursor extends LitElement {
  constructor() {
    super();

    this.addEventListener("mousedown", this.handleMousedown);
    document.addEventListener("mouseup", this.handleMouseup.bind(this));
  }

  /**
   * Resolved on demand rather than on DOMContentLoaded: this element is upgraded
   * by Lit well after that event has fired, so the old listener never ran and
   * left this permanently undefined.
   */
  private get elementTimelineRuler(): any {
    return document.querySelector("element-timeline-ruler");
  }

  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property()
  timelineScroll = this.timelineState.scroll;

  @property()
  timelineCursor = this.timelineState.cursor;

  createRenderRoot() {
    // useTimelineStore.subscribe((state) => {
    //   this.timelineScroll = state.scroll;
    //   this.timelineCursor = state.cursor;
    // });

    return this;
  }

  render() {
    this.style.display = "none";
    this.classList.add("timeline-bar");
    this.setAttribute("id", "timeline_bar");
    // Keep whatever position is already set, but start from a real number —
    // parsing an unset `left` yielded NaN and wrote back an invalid "NaNpx".
    const left = parseInt(this.style.left.split("px")[0], 10);
    this.style.left = `${Number.isNaN(left) ? 0 : left}px`;
    this.style.top = `0px`;
  }

  move(px) {
    this.style.left = `${px}px`;
  }

  handleMousedown(e) {
    const ruler = this.elementTimelineRuler;
    if (!ruler) return;

    ruler.moveTime(e);
    ruler.mousemoveEventHandler = ruler.handleMousemove.bind(ruler);
    document.addEventListener("mousemove", ruler.mousemoveEventHandler);
  }

  handleMouseup(e) {
    // Runs for every mouseup in the document, so it has to tolerate the ruler
    // not being there and a drag never having started.
    const ruler = this.elementTimelineRuler;
    if (!ruler?.mousemoveEventHandler) return;

    document.removeEventListener("mousemove", ruler.mousemoveEventHandler);
  }
}

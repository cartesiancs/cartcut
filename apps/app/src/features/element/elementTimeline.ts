import { v4 as uuidv4 } from "uuid";
import { elementUtils } from "../../utils/element";
import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { provide } from "@lit/context";
import { timelineContext } from "../../context/timelineContext";

// NOTE: 조만간 deprecated
@customElement("element-timeline")
export class ElementTimeline extends LitElement {
  elementControl: any;
  copyedTimelineData: {};
  editGuideBreakPoint: any[];

  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property()
  timeline = this.timelineState.timeline;

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
    });

    return this;
  }

  constructor() {
    super();

    //this.directory = ''
    this.elementControl;

    this.addEventListener("scroll", this.handleScroll.bind(this));

    window.addEventListener("DOMContentLoaded", () => {
      this.elementControl = document.querySelector("element-control");
    });

    this.copyedTimelineData = {};

    // NOTE: edit guide == 정렬 가이드, 모든 엘리먼트의 시작점과 끝 점을 담은 배열입니다.
    this.editGuideBreakPoint = [];
  }

  // The change detector that used to live here is now
  // `features/project/projectDirty.ts`. It hashed `this.timeline` only, so a
  // track rename or reorder read as unmodified and File → Open would clear it;
  // it was 32-bit DJB2; it compared against `Object.keys(table)[length - 1]`,
  // which is the newest entry only because V8 sorts integer-like keys
  // numerically and which two saves in one millisecond collide on; and the
  // table grew for the life of the session while only its last entry was ever
  // read. See that module's header.

  replaceTimelineBarHeight(height) {
    let timelineBar: any = this.querySelector(".timeline-bar");
    timelineBar.style.height = `${height}px`;
  }

  getTimelineScrollHeight() {
    return this.scrollHeight;
  }

  async patchTimeline(timeline) {
    this.timeline = timeline;
    this.elementControl.timeline = timeline;

    for (const elementId in timeline) {
      if (Object.hasOwnProperty.call(timeline, elementId)) {
        const element = timeline[elementId];
        await this.patchElementInTimeline({
          elementId: elementId,
          element: element,
        });
      }
    }
  }

  async patchElementInTimeline({ elementId, element }) {
    if (element.filetype == "image") {
      let blobUrl = await this.getBlobUrl(`file://${element.localpath}`);
      this.timeline[elementId].blob = String(blobUrl);
      this.elementControl.showImage(elementId);
    } else if (element.filetype == "video") {
      let blobUrl = await this.getBlobUrl(`file://${element.localpath}`);
      this.timeline[elementId].blob = String(blobUrl);
      this.elementControl.showVideo(elementId);
    } else if (element.filetype == "text") {
      document.querySelector("select-font").applyFontStyle({
        fontName: element.fontname,
        fontPath: element.fontpath,
        fontType: element.fonttype,
      });

      this.elementControl.showText(elementId);
    } else if (element.filetype == "audio") {
      let blobUrl = await this.getBlobUrl(`file://${element.localpath}`);
      this.timeline[elementId].blob = String(blobUrl);
    }
  }

  async getBlobUrl(url) {
    try {
      const response = await fetch(url);
      const data = await response.blob();
      return URL.createObjectURL(data);
    } catch (error) {
      let notfoundImage = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsSAAALEgHS3X78AAAAM0lEQVQ4jWNkYGD4z4AEUDgMDAyMBASYGCgEowaMGjA4DGD8/x8j+dPXBSzka/1PHRcAAFzYCBvm7NkTAAAAAElFTkSuQmCC`;

      console.error(error);
      const response = await fetch(notfoundImage);
      const data = await response.blob();
      return URL.createObjectURL(data);
    }
  }

  fixRulerOnTop() {
    const scrollTop = this.scrollTop;
    const elementTimelineRuler = document.querySelector(
      "element-timeline-ruler",
    );
    const elementTimelineCursor = document.querySelector(
      "element-timeline-cursor",
    );

    elementTimelineRuler.setTopPosition(scrollTop);
    elementTimelineCursor.style.top = `${scrollTop}px`;
  }

  handleScroll() {
    const scrollDom: any = this.querySelector("element-timeline-scroll");
    this.fixRulerOnTop();
    scrollDom.setScrollThumbLeft({
      px: this.scrollLeft,
    });
  }

  @provide({ context: timelineContext })
  @property()
  public timelineOptions = {
    canvasVerticalScroll: 0,
  };

  render() {
    this.classList.add(
      "col-12",
      "cursor-default",
      "h-100",
      "line",
      "bg-darker",
      "overflow-hidden",
    );

    return html`
      <element-timeline-cursor></element-timeline-cursor>

      <element-timeline-left-option></element-timeline-left-option>
      <element-timeline-canvas></element-timeline-canvas>
    `;
  }
}

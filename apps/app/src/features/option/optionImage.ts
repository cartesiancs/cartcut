import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { LocaleController } from "../../controllers/locale";
import "../filter/backgroundRemove";
import "./controlDefaultTransform";

@customElement("option-image")
export class OptionImage extends LitElement {
  elementId: string;
  private lc = new LocaleController(this);

  @property()
  timelineState: any = useTimelineStore.getInitialState();

  @property()
  timeline = this.timelineState.timeline;

  @property()
  timelineCursor = this.timelineState.cursor;

  @property()
  bgRemoveImagePath = "";

  @property()
  isShow = false;

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
      this.timelineCursor = state.cursor;
    });

    return this;
  }

  constructor() {
    super();

    this.elementId = "";
    this.hide();
  }

  render() {
    return html`
      <default-transform
        .elementId=${this.elementId}
        .timeline=${this.timeline}
        .timelineCursor=${this.timelineCursor}
        .timelineState=${this.timelineState}
        .isShow=${this.isShow}
      ></default-transform>

      <background-remove
        imagePath=${this.bgRemoveImagePath}
        @onReturn=${this.handleRemoveBackground}
      ></background-remove>
    `;
  }

  hide() {
    this.classList.add("d-none");
    this.isShow = false;
  }

  show() {
    this.classList.remove("d-none");
    this.isShow = true;
  }

  public setElementId({ elementId }) {
    this.elementId = elementId;
    this.bgRemoveImagePath = this.timeline[elementId].localpath;
    //this.updateValue();
  }

  handleRemoveBackground(e) {
    const imagePath = e.detail.path;
    console.log(imagePath, "EEE");
    this.timeline[this.elementId].localpath = imagePath;
    this.timelineState.patchTimeline(this.timeline);

    const previewCanvas = document.querySelector("preview-canvas");
    previewCanvas.preloadImage(this.elementId);
  }
}

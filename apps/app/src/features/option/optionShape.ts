import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import "./controlDefaultTransform";
import "./controlBlendMode";

@customElement("option-shape")
export class OptionShape extends LitElement {
  elementId: string;

  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property()
  timeline = this.timelineState.timeline;

  @property()
  timelineCursor = this.timelineState.cursor;

  @property()
  isShow = false;

  constructor() {
    super();

    this.elementId = "";
    this.hide();
  }

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
      this.timelineCursor = state.cursor;
    });

    return this;
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

      <blend-mode
        .elementId=${this.elementId}
        .isShow=${this.isShow}
      ></blend-mode>

      <div class="mb-2">
        <label class="form-label text-light">Fill Color</label>
        <input
          @input=${this.handleChangeColor}
          aria-event="font-color"
          type="color"
          class="form-control bg-default form-control-color"
          value="#ffffff"
          title="Choose your color"
        />
      </div>
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

  setElementId({ elementId }) {
    this.elementId = elementId;
    this.resetValue();
  }

  resetValue() {
    const timeline = document.querySelector("element-timeline").timeline;
    const fontColor: any = this.querySelector("input[aria-event='font-color'");

    fontColor.value = timeline[this.elementId].option.fillColor;
  }

  handleChangeColor() {
    const elementControl = document.querySelector("element-control");
    const fontColor: any = this.querySelector("input[aria-event='font-color'");
    const color = fontColor.value;
    // this.timeline[this.elementId].option.fillColor = color;

    this.timelineState.updateTimeline(
      this.elementId,
      ["option", "fillColor"],
      color,
    );
  }
}

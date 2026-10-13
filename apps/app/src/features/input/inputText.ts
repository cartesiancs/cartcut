import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";

@customElement("input-text")
export class InputText extends LitElement {
  value: string;
  parentInputBox: any;

  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property()
  timeline = this.timelineState.timeline;

  @property()
  elementId;

  @property()
  initValue = "";

  @property()
  initColor = "#ffffff";

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
    });

    return this;
  }

  constructor() {
    super();

    this.value = this.initValue;
    this.parentInputBox = document.querySelector(
      `element-control-asset[element-id="${this.elementId}"]`,
    );
  }

  render() {
    this.style.textAlign = "center";
    this.style.display = "flex";
    this.style.justifyContent = "center";
    this.style.height = "100%";
    this.style.width = "100%";
    this.style.position = "absolute";
    this.style.letterSpacing = "1px";
    this.style.color = this.initColor;
    // this.setWidthInner();

    return html`<span
      contenteditable="true"
      style="height: 100%; outline: none; line-height: initial; width: 100%; text-align: left;"
      @input=${this._handleInput}
      >${this.initValue}</span
    >`;
  }

  setWidth() {
    //let target = document.querySelector(`element-control-asset[element-id="${this.elementId}"]`)
    this.parentInputBox.style.width = `${this.offsetWidth}px`;
  }

  setWidthInner() {
    const element = this.timeline[this.elementId];
    // Gone when the timeline it belongs to is no longer the one showing.
    if (element?.filetype !== "text") {
      return;
    }
    console.log();
    const span: any = this.querySelector("span");
    let resizedInput = document
      .querySelector(`element-control-asset[elementid="${this.elementId}"]`)
      .convertRelativeToAbsoluteSize({
        w: span.offsetWidth,
      });

    element.widthInner = resizedInput.w;
    this.timelineState.patchTimeline(this.timeline);
  }

  updateText({ value }: { value: string }) {
    const element = this.timeline[this.elementId];
    // Gone when the timeline it belongs to is no longer the one showing.
    if (element?.filetype !== "text") {
      return;
    }
    console.log(element, this.timeline, this.elementId);
    element.text = value;
  }

  _handleInput(event) {
    event.preventDefault();
    let value = event.target.outerText;

    this.updateText({ value: value });
    // this.setWidth();
    // this.setWidthInner();
  }
}

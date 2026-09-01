import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import "./controlDefaultTransform";
import "./controlBlendMode";
import "./optionLutSection";
import "./optionMaskSection";
import "./optionTabBar";
import type { OptionTab } from "./optionTabBar";

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

  /**
   * Which pane is showing. Component state, not document state: it is where the
   * user is looking, not something about the clip.
   */
  @property()
  tab: OptionTab = "media";

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
      <option-tab-bar
        .active=${this.tab}
        @tab-change=${(e: CustomEvent<OptionTab>) => {
          this.tab = e.detail;
        }}
      ></option-tab-bar>

      <!-- Both panes stay mounted; only one is shown. See optionTabBar.ts -->
      <div class=${this.tab === "mask" ? "" : "d-none"}>
        <option-mask-section
          .elementIds=${[this.elementId]}
        ></option-mask-section>
      </div>

      <div class=${this.tab === "media" ? "" : "d-none"}>
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

      <!--
        Next to the blend mode, because the two are the same question asked
        twice: how this clip's picture is changed before it meets the scene,
        and how it meets it. Picking *which* filter happens in the Filter tab
        against thumbnails; what belongs here is how strongly it applies.
      -->
      <option-lut-section
        .elementId=${this.elementId}
      ></option-lut-section>

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

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { LocaleController } from "../../controllers/locale";
import "../filter/backgroundRemove";
import "./controlDefaultTransform";
import "./controlBlendMode";
import "./optionLutSection";
import "./optionMaskSection";
import "./optionTabBar";
import type { OptionTab } from "./optionTabBar";

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

  /**
   * Which pane is showing. Component state, not document state: it is where the
   * user is looking, not something about the clip.
   */
  @property()
  tab: OptionTab = "media";

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

      <background-remove
        imagePath=${this.bgRemoveImagePath}
        @onReturn=${this.handleRemoveBackground}
      ></background-remove>
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

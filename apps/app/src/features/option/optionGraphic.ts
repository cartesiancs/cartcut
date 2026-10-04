/**
 * The inspector for a graphic. Tag name fixed by `optionGroup`'s
 * `option-${filetype}` convention.
 *
 * Composed from the sections every visual clip shares (transform, blend, LUT,
 * adjustments, mask, animation presets) and the graphic's own. No decoration
 * section: a graphic is not `Decorated`, because a box border and shadow are
 * wrong for lettering and a card draws its own.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import "./controlDefaultTransform";
import "./controlBlendMode";
import "./optionLutSection";
import "./optionAdjustSection";
import "./optionMaskSection";
import "./animationPresetBrowser";
import "./optionTabBar";
import "./optionGraphicSection";
import type { OptionTab } from "./optionTabBar";

@customElement("option-graphic")
export class OptionGraphic extends LitElement {
  elementId: string;

  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property()
  timeline = this.timelineState.timeline;

  @property()
  timelineCursor = this.timelineState.cursor;

  @property()
  isShow = false;

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
    const element = this.timeline?.[this.elementId] ?? null;
    return html`
      <option-tab-bar
        .active=${this.tab}
        @tab-change=${(e: CustomEvent<OptionTab>) => {
          this.tab = e.detail;
        }}
      ></option-tab-bar>

      <div class=${this.tab === "adjust" ? "" : "d-none"}>
        <option-adjust-section .elementIds=${[this.elementId]}></option-adjust-section>
      </div>

      <div class=${this.tab === "mask" ? "" : "d-none"}>
        <option-mask-section .elementIds=${[this.elementId]}></option-mask-section>
      </div>

      <div class=${this.tab === "animation" ? "" : "d-none"}>
        <animation-preset-browser .elementIds=${[this.elementId]}></animation-preset-browser>
      </div>

      <div class=${this.tab === "media" ? "" : "d-none"}>
        <default-transform
          .elementId=${this.elementId}
          .timeline=${this.timeline}
          .timelineCursor=${this.timelineCursor}
          .timelineState=${this.timelineState}
          .isShow=${this.isShow}
        ></default-transform>

        <option-graphic-section
          .elementId=${this.elementId}
          .element=${element}
        ></option-graphic-section>

        <blend-mode .elementId=${this.elementId} .isShow=${this.isShow}></blend-mode>

        <option-lut-section .elementId=${this.elementId}></option-lut-section>
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

  setElementId({ elementId }: { elementId: string }) {
    this.elementId = elementId;
    this.requestUpdate();
  }
}

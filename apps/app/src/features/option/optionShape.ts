import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import "./controlDefaultTransform";
import "./controlBlendMode";
import "./optionLutSection";
import "./optionAdjustSection";
import "./optionMaskSection";
import "./optionShapeSection";
import "./optionDecorationSection";
import "./animationPresetBrowser";
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

      <!-- Every pane stays mounted; only one is shown. See optionTabBar.ts -->
      <div class=${this.tab === "adjust" ? "" : "d-none"}>
        <option-adjust-section
          .elementIds=${[this.elementId]}
        ></option-adjust-section>
      </div>

      <div class=${this.tab === "mask" ? "" : "d-none"}>
        <option-mask-section
          .elementIds=${[this.elementId]}
        ></option-mask-section>
      </div>

      <div class=${this.tab === "animation" ? "" : "d-none"}>
        <animation-preset-browser
          .elementIds=${[this.elementId]}
        ></animation-preset-browser>
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

      <!--
        The shape's own controls, and its fill, in one section. Both write
        through timeline/shapeOps.ts: the fill used to go straight into the
        store with updateTimeline, which records no undo step at all, so a
        colour change could not be taken back and a colour picker's drag wrote
        once per input event.

        No backticks in here. This is inside a lit html template literal, so
        one would end the template and the rest of the panel becomes syntax.
      -->
      <option-shape-section
        .elementIds=${[this.elementId]}
      ></option-shape-section>

      <!--
        Border and drop shadow. Shape, image and video share this section
        because they share the field: all three draw a picture inside a box.
        Text has its own pair under Effects, which strokes the glyphs.
      -->
      <option-decoration-section
        .elementIds=${[this.elementId]}
      ></option-decoration-section>

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
    // No `resetValue` any more. Every control in the section binds with
    // `.value=` against the store it reads on each render, so there is nothing
    // to push into the DOM by hand. The old one also reached through
    // `document.querySelector("element-timeline").timeline` with no guards,
    // into a `try {} catch {}` in `optionGroup.showOption` that would have
    // shown the panel blank rather than saying anything.
    this.requestUpdate();
  }
}

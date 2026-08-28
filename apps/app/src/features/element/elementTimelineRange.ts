import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { rangeFromSlider, sliderFromRange } from "../timeline/zoom";
import { projectFps } from "../editor/frameRate";

@customElement("element-timeline-range")
export class ElementTimelineRange extends LitElement {
  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property()
  timelineRange = this.timelineState.range;

  @property()
  timelineCursor = this.timelineState.cursor;

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timelineRange = state.range;
      this.timelineCursor = state.cursor;

      const input: any = document.querySelector("#timelineRange");
      if (!input) return;
      input.value = sliderFromRange(state.range, projectFps());
      this.syncFill(input);
    });

    return this;
  }

  // Paints the travelled part of the track. Webkit has no ::-webkit-slider
  // pseudo for it, so the track is a gradient driven by this custom property.
  syncFill(input: HTMLInputElement) {
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    const value = parseFloat(input.value);
    const percent = ((value - min) / (max - min)) * 100;
    input.style.setProperty("--range-fill", `${percent}%`);
  }

  updated() {
    const input = this.querySelector<HTMLInputElement>("#timelineRange");
    if (input) this.syncFill(input);
  }

  constructor() {
    super();
  }

  render() {
    this.style.padding = "0px";
    return html`
      <div class="d-flex col align-items-center justify-content-end gap-2">
        <span class="material-symbols-outlined icon-xsm"> zoom_out </span>
        <input
          ref="range"
          type="range"
          min="0"
          max="1"
          step="0.0005"
          id="timelineRange"
          value="0.571"
          @change=${this.updateRange}
          @input=${this.updateRange}
        />
        <span class="material-symbols-outlined icon-xsm"> zoom_in </span>
      </div>
    `;
  }

  updateValue() {
    let inputRange: any = this.querySelector("input[ref='range']");
    let newValue = parseFloat(
      (
        (parseFloat(inputRange.value) * parseFloat(inputRange.value)) /
        10
      ).toFixed(3),
    );
    if (newValue <= 0) {
      return 0;
    }
    // this.value = parseFloat(
    //   ((inputRange.value * inputRange.value) / 10).toFixed(3)
    // );

    // this.timelineState.setRange(this.value);
  }

  updateRange(e) {
    this.updateValue();
    this.syncFill(e.target);
    const elementControlComponent = document.querySelector("element-control");
    elementControlComponent.changeTimelineRange();

    // The track is plain `[0, 1]` now and `zoom.ts` owns the curve. It used to
    // be a logit window pushed through a sigmoid, which capped the range at 10
    // however far the slider travelled — and at 10 a 60fps frame is 8.3px wide,
    // too narrow to edit a cut against.
    this.timelineState.setRange(
      rangeFromSlider(parseFloat(e.target.value), projectFps()),
    );
  }
}

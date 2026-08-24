import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";

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

      const x = -Math.log(10 / state.range - 1);
      const input: any = document.querySelector("#timelineRange");
      if (!input) return;
      input.value = x;
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
          min="-8"
          max="5"
          step="0.01"
          id="timelineRange"
          value="-2"
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

    const x = parseFloat(e.target.value);
    const rx = (1 / (1 + Math.pow(Math.E, -x))) * 10;
    this.timelineState.setRange(rx);

    //this.timelineState.setRange(parseFloat(e.target.value));
  }
}

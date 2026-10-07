import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import "./controlAudioVolume";
import "./controlClipSpeed";

/**
 * The side panel for an audio clip.
 *
 * Was a stub: a label and an empty `<div>`, rendered into a shadow root where
 * the app's global Bootstrap classes could not reach it, plus an `updateValue`
 * that read the timeline and discarded it. It now carries the level fader, in
 * the shape `optionImage` established — light DOM, store subscription, and
 * `isShow` flipped alongside the `d-none` class.
 *
 * That last part is load-bearing: `<audio-volume>` guards its read-back on
 * `isShow`, so a `show()` that forgot it would leave the field permanently
 * showing 0.00. And `optionGroup.showOption` wraps `setElementId` in a bare
 * `try {} catch {}`, so anything that throws in here blanks the panel with no
 * console error — which is why `setElementId` touches nothing but the id.
 */
@customElement("option-audio")
export class OptionAudio extends LitElement {
  elementId: string;

  @property()
  timelineState: any = useTimelineStore.getInitialState();

  @property()
  timeline = this.timelineState.timeline;

  @property()
  isShow = false;

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
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
      <audio-volume
        .elementId=${this.elementId}
        .isShow=${this.isShow}
      ></audio-volume>

      <clip-speed
        .elementId=${this.elementId}
        .isShow=${this.isShow}
      ></clip-speed>
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
  }
}

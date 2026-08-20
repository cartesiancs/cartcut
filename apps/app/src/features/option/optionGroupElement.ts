import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import "./controlDefaultTransform";

/**
 * The side panel for a group.
 *
 * Named `option-groupelement`, not `option-group`: `<option-group>` is already
 * the *container* every option panel lives inside, and `optionGroup.showOption`
 * looks its child up by `option-${filetype}`. A group whose filetype is
 * `"group"` would therefore send that lookup at the container itself, which
 * quietly resolves to nothing and leaves the panel blank. The `PANEL_TAG` map
 * in `optionGroup.ts` is what routes it here instead.
 *
 * There is nothing group-specific in it. A group's position, rotation, opacity
 * and scale are the same four properties every other element has, edited by the
 * same `default-transform` control — which is the point of making a group a
 * real element rather than an entry in some parallel registry.
 */
@customElement("option-groupelement")
export class OptionGroupElement extends LitElement {
  elementId: string;

  @property()
  timelineState: any = useTimelineStore.getInitialState();

  @property()
  timeline = this.timelineState.timeline;

  @property()
  timelineCursor = this.timelineState.cursor;

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

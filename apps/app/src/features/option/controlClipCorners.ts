/**
 * Corners, in the option panel's Media tab: one radius for an image or a video.
 *
 * Mounted directly above the Border and Shadow sections, because the three are
 * one look. A border and a shadow trace the rounded outline, so a user rounding
 * a card reaches for all three together. Self-gating like `clip-crop` and
 * `clip-orientation`: a panel may mount it for any clip and it renders nothing
 * for one that cannot be rounded, which is every type but image and video. A
 * shape keeps its own radius in the Shape section.
 *
 * Built like Border and Shadow beside it: the eye on the head switches the
 * corners off and on, and the body is there only while they are on. Off keeps
 * the radius and any curve on it (`cornerRadiusOff`), so switching back on
 * gives them back; on, for a square clip, rounds it with a twentieth of its
 * shorter side, the way the border's eye writes its defaults.
 *
 * Keyframeable the way the level fader is, with the same arrangement: the
 * field shows the radius at the playhead through `cornerRadiusAt`, and with the
 * stopwatch armed an edit keys the playhead as well as the field. That rule is
 * `timeline/cornerEdit.ts`, out of this class so a node suite can check it.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import {
  cornerRadiusAt,
  cornersOn,
  defaultCornerRadius,
  isRoundable,
  setCornerRadiusOff,
  showCorners,
} from "../timeline/cornerOps";
import { editCornerRadius } from "../timeline/cornerEdit";
import { sampledBoxOf } from "../timeline/transform";
import { projectBakeHz } from "../editor/frameRate";
import { refusesEdit } from "../editor/timelineLock";
import { GestureCommit } from "./gestureCommit";
import { eyeButton, section, sliderField } from "./optionKit";
import type { TimelineDocument } from "../timeline/tracks";
import "./controlKeyframeNav";

@customElement("clip-corners")
export class ClipCornersControl extends LitElement {
  @property()
  elementId = "";

  @property()
  isShow = false;

  /** Coalesces a slider drag into a single undo step. */
  private gesture = new GestureCommit();
  private teardown: Array<() => void> = [];

  createRenderRoot() {
    // Light DOM: the option kit's classes come from a global stylesheet. The
    // subscription also covers the cursor, which is what keeps the field on
    // the keyed radius while the playhead moves.
    this.teardown.push(
      useTimelineStore.subscribe(() => {
        if (this.isShow) {
          this.requestUpdate();
        }
      }),
    );
    // The timeline canvas clears the selection on any mousedown outside itself,
    // which fires before the slider receives its own.
    this.setAttribute("data-keeps-selection", "");
    // A spinner drag abandoned with Escape.
    this.addEventListener("onCancel", () => this.gesture.cancel());
    return this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    for (const off of this.teardown) {
      off();
    }
    this.teardown = [];
  }

  // Arrow properties, every handler: this template is rendered inside the
  // option panel's own, and a method passed as a listener there would bind
  // `this` to whichever component Lit treats as the host.
  private scrub = (next: number): void => {
    const id = this.elementId;
    const cursor = useTimelineStore.getState().cursor;
    // `projectBakeHz()`, not the op's 60Hz default: a baked lane is read by
    // nearest sample, so one written coarser than the project steps.
    const bakeHz = projectBakeHz();
    this.gesture.apply((doc) => editCornerRadius(doc, id, next, cursor, bakeHz));
    this.requestUpdate();
  };

  private commit = (): void => {
    this.gesture.flush();
    this.requestUpdate();
  };

  /** One immediate step, for the eye or a typed number. */
  private write(fn: (doc: TimelineDocument) => TimelineDocument): void {
    this.gesture.flush();
    // `GestureCommit.apply` refuses under the caption lock on its own; a
    // straight `withCheckpoint` does not, so this has to ask.
    if (refusesEdit()) {
      this.requestUpdate();
      return;
    }
    useTimelineStore.getState().withCheckpoint(fn);
    this.requestUpdate();
  }

  private typed = (next: number): void => {
    const id = this.elementId;
    const cursor = useTimelineStore.getState().cursor;
    const bakeHz = projectBakeHz();
    this.write((doc) => editCornerRadius(doc, id, next, cursor, bakeHz));
  };

  private toggle = (): void => {
    const id = this.elementId;
    const element = useTimelineStore.getState().timeline[id];
    if (element == null) {
      return;
    }
    if (cornersOn(element)) {
      this.write((doc) => setCornerRadiusOff(doc, id, true));
      return;
    }
    const box = sampledBoxOf(element, useTimelineStore.getState().cursor);
    const radius = defaultCornerRadius(box.width, box.height);
    this.write((doc) => showCorners(doc, id, radius));
  };

  private invalid = (): void => {
    this.requestUpdate();
  };

  render() {
    const element = useTimelineStore.getState().timeline[this.elementId];
    if (element == null || !isRoundable(element)) {
      return nothing;
    }
    const on = cornersOn(element);
    const eye = eyeButton(
      on,
      on ? "Turn corners off" : "Turn corners on",
      this.toggle,
      "corner-radius",
    );
    if (!on) {
      return section({ title: "Corners", actions: eye });
    }

    const cursor = useTimelineStore.getState().cursor;
    const radius = Math.round(cornerRadiusAt(element, cursor));
    // Half the shorter side of the box being drawn, which is where the corners
    // meet and the clip becomes a pill. The renderer stops there whatever is
    // stored, so the slider does too; the box still takes a larger number,
    // which is kept rather than refused and comes back if the box grows.
    const box = sampledBoxOf(element, cursor);
    const ceiling = Math.max(1, Math.round(Math.min(box.width, box.height) / 2));

    // The keyframe nav on the head beside the eye, rather than beside the
    // box: the column is about 150px, and three nav buttons in the row left
    // the label four letters wide. Only while the corners are on, since off
    // there is nothing on screen to key.
    return section({
      title: "Corners",
      actions: html`<control-keyframe-nav
          .elementId=${this.elementId}
          .property=${"cornerRadius"}
          .label=${"corner radius"}
        ></control-keyframe-nav>
        ${eye}`,
      body: html`
        <div class="opt-field" data-corner-radius>
          ${sliderField({
            label: "Radius",
            suffix: "px",
            value: radius,
            rangeValue: Math.min(ceiling, radius),
            // 1, not 0: a radius of 0 is square, which is the eye off, and a
            // drag that reached it would fold the section away under the
            // pointer. A typed 0 still squares the clip, deliberately.
            min: 1,
            max: ceiling,
            onScrub: this.scrub,
            onCommit: this.commit,
            onTyped: this.typed,
            onInvalid: this.invalid,
          })}
        </div>
      `,
    });
  }
}

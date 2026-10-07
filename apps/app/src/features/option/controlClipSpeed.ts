/**
 * The Speed section, shared by the video and audio option panels.
 *
 * One component rather than the same row inlined twice, for the reason
 * `controlAudioVolume.ts` gives — and mounted in both panels because *both*
 * element types carry `speed`. An audio clip detached from its video would
 * otherwise be the one clip in the project whose rate the user could not reach.
 *
 * **A `<select>`, not a scrub.** Every other control in this folder edits a
 * property of the picture; this one *resizes the clip on the timeline*, since
 * `spanLength` is `duration / speed`. A `<number-input>` fires `onChange` on
 * every mousemove, so a drag would rewrite every trailing clip on the lane
 * hundreds of times over — and it is mechanically wrong for this range besides:
 * it scrubs at 0.3 units per pixel and snaps to 0.1, so 0.25x is unreachable and
 * the whole 0.25..4 range is about twelve pixels of travel. A discrete pick is
 * one `change`, one `withCheckpoint`, one undo step, and no `GestureCommit`.
 *
 * **Every rate is always offered.** The ripple below shifts each later clip on
 * the lane by exactly the amount this one grew or shrank, so the gap in front of
 * them changes by the same amount and a collision has nowhere to come from —
 * pinned by `speedOps.test.ts`, "never declines for a collision". That is what
 * spares this panel a disabled state, a "no room" hint, and a ripple toggle to
 * explain them.
 *
 * **A `+` section**, like Blend: a clip at 1x with no ramp shows the name and
 * the `+`, and the rates appear once it is pressed. Opening writes nothing,
 * since the list opens on 1x; `×` sets 1x back, which flattens a ramp too, and
 * folds the section shut.
 */

import { LitElement, PropertyValues, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import { LocaleController } from "../../controllers/locale";
import { speedOf } from "../timeline/geometry";
import {
  coerceSpeed,
  isSpeedAdjustable,
  formatSpeedOption,
  setClipSpeed,
  speedOptionsFor,
  SPEED_PRESETS,
} from "../timeline/speedOps";
import { speedCurveOf } from "../timeline/speedCurve";
import { addButton, removeButton, section } from "./optionKit";

@customElement("clip-speed")
export class ClipSpeedControl extends LitElement {
  private lc = new LocaleController(this);

  @property()
  elementId = "";

  @property()
  isShow = false;

  createRenderRoot() {
    // Light DOM: the Bootstrap classes below come from a global stylesheet,
    // which does not cross a shadow boundary.
    useTimelineStore.subscribe(() => {
      if (this.isShow) {
        this.requestUpdate();
      }
    });

    // The timeline canvas clears the selection on any mousedown outside itself,
    // which fires before the `change` this control acts on.
    this.setAttribute("data-keeps-selection", "");

    return this;
  }

  /**
   * The clip this control is pointed at, read from the store on every render.
   *
   * Never cached in a field — `optionVideo.ts` documents what caching cost
   * there. Deriving it means the dropdown follows an undo, or a `set_clip_speed`
   * the agent ran, without being told to.
   */
  private get element() {
    return useTimelineStore.getState().timeline[this.elementId];
  }

  /**
   * Whether `+` has opened the section on a clip still at 1x. Component state,
   * for the reason `controlBlendMode.ts` gives for its own.
   */
  private opened = false;

  willUpdate(changed: PropertyValues<this>) {
    if (changed.has("elementId")) {
      this.opened = false;
    }
  }

  render() {
    const element = this.element;
    // Self-gating, like `option-lut-section`: a panel may mount this without
    // knowing whether the clip has a rate, and an image simply shows nothing.
    if (!isSpeedAdjustable(element)) {
      return html``;
    }

    const speed = speedOf(element);
    // On a ramped clip `speedOf` is the *mean* rate, and showing it as a plain
    // pick would read as a lie: the clip never plays at that rate for a whole
    // frame. The entry names the ramp and reports the mean as what it is.
    //
    // It also takes the mean out of the list. `speedOptionsFor` splices a rate
    // that is not a preset into the menu, which is right for a clip the agent
    // set to 1.7x and wrong here: the mean of a ramp is an arbitrary float
    // nobody chose, and a live one rendered as "0.4009824491765815x".
    const ramped = speedCurveOf(element) != null;

    if (!ramped && speed === 1 && !this.opened) {
      return section({
        title: this.lc.t("setting.speed"),
        actions: addButton(
          "Change how fast this clip plays",
          this.handleOpen,
          "clip_speed_add",
        ),
      });
    }

    // The list takes the body's whole width, as Blend's does: the section's
    // name says what it picks, and "Ramp (0.40x)" needs the room.
    return section({
      title: this.lc.t("setting.speed"),
      actions: removeButton("Back to 1x", this.handleRemove, "clip_speed_reset"),
      body: html`
        <select
          class="opt-select"
          aria-label="clip speed"
          aria-event="clip_speed"
          @change=${this.handleChange}
        >
          ${ramped
            ? html`<option value="ramp">
                ${this.lc.t("setting.speed_ramp_option")} (${speed.toFixed(2)}x)
              </option>`
            : ``}
          ${(ramped ? SPEED_PRESETS : speedOptionsFor(speed)).map(
            (option) =>
              html`<option value=${String(option)}>
                ${formatSpeedOption(option)}x
              </option>`,
          )}
        </select>
      `,
    });
  }

  /**
   * Point the `<select>` at the document's rate, after the options exist.
   *
   * Not a `.value` binding in the template, which is where this started and what
   * it looked like it should be. lit commits the parts of one template in
   * document order, so the property part runs *before* the child part that
   * builds the `<option>`s — assigning to a `<select>` with no children selects
   * nothing, and the browser then picks the first option as they arrive. A 1x
   * clip rendered as "0.25x", and the next thing the user did would have been
   * read as agreeing with it.
   */
  updated() {
    const select = this.querySelector<HTMLSelectElement>(
      "select[aria-event='clip_speed']",
    );
    const element = this.element;
    if (select == null || !isSpeedAdjustable(element)) {
      return;
    }
    select.value =
      speedCurveOf(element) != null ? "ramp" : String(speedOf(element));
  }

  /**
   * Apply the pick as one undo step.
   *
   * Nothing here handles a decline, and nothing needs to: the `<select>` is a
   * pure function of the document, so `.value` is re-bound from `speedOf` on the
   * next store notification and a refused change snaps the field back on its
   * own. That is the other half of why this is not a `<number-input>` — that
   * widget owns its own value, which is why `audio-volume` has to write
   * `dom.value` imperatively to keep it honest.
   *
   * `ripple: true` matches `set_clip_speed`'s own default, and is the only
   * setting under which every listed rate is reachable. It is lane-local, the
   * same rule `rippleDelete` follows: a clip on another track never moves.
   *
   * **Picking a rate flattens a speed ramp**, which `setClipSpeed` does and
   * documents. Destructive and deliberate: this control states one rate for the
   * whole clip, and a rate riding on top of a curve would be a third meaning
   * for `speed`. The graph sits directly below showing what is about to go, and
   * undo is one keystroke, so there is no confirm. Re-picking the "Ramp" entry
   * is not a rate at all: `coerceSpeed` answers null for it and nothing
   * happens, which is the decline this handler already had.
   */
  private handleOpen = () => {
    this.opened = true;
    this.requestUpdate();
  };

  /**
   * 1x again, as one undo step, and the section shut.
   *
   * Through the same op and the same ripple as a pick from the list, so `×` is
   * exactly "choose 1x": it flattens a ramp, and it declines by identity for a
   * clip that was only opened, which records nothing.
   */
  private handleRemove = () => {
    this.opened = false;
    const elementId = this.elementId;
    useTimelineStore
      .getState()
      .withCheckpoint((doc) =>
        setClipSpeed(doc, elementId, 1, { ripple: true }),
      );
    this.requestUpdate();
  };

  private handleChange = (event: Event) => {
    const speed = coerceSpeed((event.target as HTMLSelectElement).value);
    if (speed == null) {
      return;
    }

    const elementId = this.elementId;
    useTimelineStore
      .getState()
      .withCheckpoint((doc) =>
        setClipSpeed(doc, elementId, speed, { ripple: true }),
      );

    this.requestUpdate();
  };
}

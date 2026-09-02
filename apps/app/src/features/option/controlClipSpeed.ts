/**
 * The playback-rate dropdown, shared by the video and audio option panels.
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
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import { LocaleController } from "../../controllers/locale";
import { speedOf } from "../timeline/geometry";
import {
  coerceSpeed,
  isSpeedAdjustable,
  setClipSpeed,
  speedOptionsFor,
} from "../timeline/speedOps";

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

  render() {
    const element = this.element;
    // Self-gating, like `option-lut-section`: a panel may mount this without
    // knowing whether the clip has a rate, and an image simply shows nothing.
    if (!isSpeedAdjustable(element)) {
      return html``;
    }

    const speed = speedOf(element);

    return html`
      <label class="form-label text-light">${this.lc.t("setting.speed")}</label>
      <select
        class="form-select bg-dark text-light form-select-sm mb-3"
        aria-label="clip speed"
        aria-event="clip_speed"
        @change=${this.handleChange}
      >
        ${speedOptionsFor(speed).map(
          (option) =>
            html`<option value=${String(option)}>${option}x</option>`,
        )}
      </select>
    `;
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
    select.value = String(speedOf(element));
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
   */
  private handleChange(event: Event) {
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
  }
}

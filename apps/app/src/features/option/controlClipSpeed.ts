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
 * the `+`, and the body appears once it is pressed. Opening writes nothing,
 * since it opens on Constant at 1x; `×` sets 1x back, which flattens a ramp
 * too, and folds the section shut.
 *
 * ## Constant or Ramp: one section, two modes
 *
 * The body leads with a switch between the two ways a clip can have a rate,
 * and shows the editor for the one chosen: the rate list, or the ramp's graph
 * (`controlSpeedCurve.ts`, mounted only while Ramp is chosen). They were two
 * sections, and picking a rate in the upper one silently flattened whatever
 * the lower one had drawn; as two modes of one property that is just what
 * switching mode means.
 *
 * **Choosing Ramp arms it and writes nothing.** The graph opens as the flat
 * line the clip is already playing, and `coerceSpeedCurve` answers `null` for a
 * flat curve, so `setClipSpeedCurve` declines and the clip neither resizes nor
 * ripples its lane until a point actually moves. A switch that seeded a real
 * ramp would change how the clip plays as the price of looking at it.
 *
 * The armed flag is component state, never a field on the element: it would be
 * UI state in the project file, and an armed-but-flat ramp would save a key for
 * nothing. It **latches** whenever the clip is seen carrying a ramp, so
 * dragging the last bend out of a curve (which deletes it) leaves the graph
 * under the pointer instead of switching the section to Constant mid-drag, and
 * a ramp the agent adds while the panel is open switches it to Ramp. Only the
 * Constant cell, `×` and moving to another clip clear it.
 *
 * **Choosing Constant removes the ramp and keeps its mean**, so the clip keeps
 * its length and its neighbours stay put; the rate list then shows that mean,
 * and a pick from it is the next edit. No confirm: the graph showed what was
 * there, and undo is one keystroke.
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
  setClipSpeedCurve,
  speedOptionsFor,
} from "../timeline/speedOps";
import { speedCurveOf } from "../timeline/speedCurve";
import { isRampArmed } from "../speed/curveGraph";
import { addButton, removeButton, section } from "./optionKit";
import "./controlSpeedCurve";

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

  /** Whether Ramp is chosen. Latched; see the header. */
  private rampArmed = false;

  willUpdate(changed: PropertyValues<this>) {
    if (changed.has("elementId")) {
      this.opened = false;
      this.rampArmed = false;
    }
    // After the reset, so a clip arriving with a ramp opens on Ramp.
    if (speedCurveOf(this.element) != null) {
      this.rampArmed = true;
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
    const ramped = speedCurveOf(element) != null;
    const ramp = isRampArmed(ramped, this.rampArmed);

    if (!ramp && speed === 1 && !this.opened) {
      return section({
        title: this.lc.t("setting.speed"),
        actions: addButton(
          "Change how fast this clip plays",
          this.handleOpen,
          "clip_speed_add",
        ),
      });
    }

    return section({
      title: this.lc.t("setting.speed"),
      actions: removeButton("Back to 1x", this.handleRemove, "clip_speed_reset"),
      body: html`
        <div class="opt-field">
          <div class="opt-seg" role="group" aria-label="Speed mode">
            <button
              type="button"
              class="opt-seg-item ${ramp ? "" : "is-on"}"
              aria-pressed=${ramp ? "false" : "true"}
              aria-event="speed_constant"
              title="One rate for the whole clip"
              @click=${this.handleConstant}
            >
              ${this.lc.t("setting.speed_ramp_constant")}
            </button>
            <button
              type="button"
              class="opt-seg-item ${ramp ? "is-on" : ""}"
              aria-pressed=${ramp ? "true" : "false"}
              aria-event="speed_ramp_toggle"
              title="A rate that changes across the clip"
              @click=${this.handleRamp}
            >
              ${this.lc.t("setting.speed_ramp_option")}
            </button>
          </div>
        </div>
        <div class="opt-field">
          ${ramp ? this.rampEditor(speed) : this.rateList(speed)}
        </div>
      `,
    });
  }

  /**
   * The rates, full width. A rate that is not a preset (one the agent set, or
   * the mean a ramp left behind) is spliced in by `speedOptionsFor` so the list
   * can show it.
   */
  private rateList(speed: number) {
    return html`
      <select
        class="opt-select"
        aria-label="clip speed"
        aria-event="clip_speed"
        @change=${this.handleChange}
      >
        ${speedOptionsFor(speed).map(
          (option) =>
            html`<option value=${String(option)}>
              ${formatSpeedOption(option)}x
            </option>`,
        )}
      </select>
    `;
  }

  /**
   * The ramp's mean, then its graph.
   *
   * The mean is what the rate list used to report as "Ramp (0.40x)": the one
   * number that says how much the ramp changed the clip's length. Rounded to
   * two places, because the live value is an arbitrary float nobody chose and
   * once rendered as "0.4009824491765815x".
   */
  private rampEditor(speed: number) {
    return html`
      <div class="opt-row" style="margin-bottom: 8px;">
        <span class="opt-label">${this.lc.t("setting.speed_ramp_average")}</span>
        <span class="opt-value">${formatSpeedOption(speed)}x</span>
      </div>
      <clip-speed-curve
        .elementId=${this.elementId}
        .isShow=${this.isShow}
      ></clip-speed-curve>
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
   *
   * `setClipSpeed` flattens a speed ramp, and documents it, but from this
   * panel the list never meets one: it is only shown on Constant, and the
   * ramp is gone by the time Constant is chosen. The flattening is for the
   * agent's `set_clip_speed`, which has no mode to switch.
   */
  private handleOpen = () => {
    this.opened = true;
    this.requestUpdate();
  };

  /** Arm the ramp. Writes nothing; see the header. */
  private handleRamp = () => {
    this.rampArmed = true;
    this.requestUpdate();
  };

  /**
   * Back to one rate: the ramp removed, its mean kept.
   *
   * The flag is cleared *before* the commit and the latch reads the document
   * *after* it, so a refused edit (the caption lock) leaves the curve in place
   * and the next render puts the section straight back on Ramp, which is the
   * truth. On a clip that was only armed the op declines and nothing is
   * recorded.
   */
  private handleConstant = () => {
    this.rampArmed = false;
    const elementId = this.elementId;
    useTimelineStore
      .getState()
      .withCheckpoint((doc) =>
        setClipSpeedCurve(doc, elementId, null, { ripple: true }),
      );
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
    this.rampArmed = false;
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

/**
 * The Reveal controls, in a text clip's Animation tab.
 *
 * They sit above the preset grid rather than in the Media tab because a reveal
 * *is* animation — it is one keyframe track on one scalar, authored with the
 * same stopwatch and edited in the same curve editor as position or opacity.
 * Putting it beside the font size would have filed the only text control that
 * moves under the ones that do not.
 *
 * ## Two layers, and the panel shows both
 *
 * The unit and the softness say what a progress *means*; the progress itself is
 * an ordinary keyframe track. So the top of this panel is a cadence and the
 * bottom is a number with a stopwatch beside it, and "Typewriter" is a shortcut
 * that fills the second one in — it writes exactly the two keyframes a user
 * could place by hand, which is why there is nothing here to undo it with. The
 * stopwatch turns it off; the curve editor re-times it.
 *
 * ## Every field writes its static value and its keyframe together
 *
 * `commitField` is `optionMaskSection`'s, which is `controlDefaultTransform`'s:
 * the field *and*, when the track is switched on, a keyframe at the playhead,
 * inside one `GestureCommit`. Doing them separately is what let a scrub record
 * one undo step per mousemove, and what let an active track immediately
 * overwrite the number the user had just typed.
 *
 * ## The Animator card
 *
 * What a unit does on its way in (`TextReveal.animate`), the panel half of
 * `set_text_reveal`'s `animate*` arguments; until this card it was reachable
 * from MCP alone. Its rules are in `revealAnimatorFields.ts`, node-tested.
 *
 * The eye arms the card and **writes nothing**, the rule `controlSpeedCurve`
 * states: an animator whose every field is inert is not stored, so arming shows
 * the inert values and the first edit is what creates it. Every edit re-arms,
 * so dragging the last movement back to inert deletes the animator without
 * closing the card under the pointer. Overlap and Easing are dimmed until
 * something moves, because neither makes an animator on its own and the op
 * would decline the edit.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import {
  REVEAL_UNITS,
  type RevealUnit,
  type TextReveal,
  type TimelineElement,
} from "../../@types/timeline";
import { useTimelineStore } from "../../states/timelineStore";
import { addKeyframe } from "../animation/keyframeOps";
import { projectBakeHz } from "../editor/frameRate";
import { playheadAnchor } from "../animation/presets";
import { revealOf } from "../text/reveal";
import { applyTypewriter } from "../text/typewriter";
import {
  isRevealable,
  setClipTextReveal,
  setClipTextRevealFields,
  type RevealFieldPatch,
} from "../timeline/textRevealOps";
import { GestureCommit } from "./gestureCommit";
import "./controlKeyframeNav";
import "../../components/input/input";
import { eyeButton, section } from "./optionKit";
import {
  ANIMATOR_BOXES,
  animatorEasingOptions,
  animatorEasingPatch,
  animatorMovePatch,
  animatorValuesOf,
  animatorWindowPatch,
  hasAnimator,
  type AnimatorMoveKey,
} from "./revealAnimatorFields";

/** One word each. The panel has no prose in it, deliberately. */
const UNIT_LABEL: Record<RevealUnit, string> = {
  character: "Char",
  word: "Word",
  line: "Line",
};

/** What the Typewriter button uses until the user says otherwise. */
const DEFAULT_TYPEWRITER_MS = 1200;

@customElement("option-text-reveal-section")
export class OptionTextRevealSection extends LitElement {
  /**
   * The clips to act on.
   *
   * An array because `option-text` is the one multi-select inspector. The first
   * id is the one the panel *reads* from; every id is written to.
   */
  @property({ type: Array })
  elementIds: string[] = [];

  /**
   * Component state, not document state: how long the next Typewriter click
   * should take. It is a control on a button rather than a property of the
   * clip — once clicked, the keyframes are the truth, and re-reading them back
   * into this box would make dragging one in the curve editor silently change
   * what the button would do next.
   */
  @property({ type: Number })
  typewriterMs = DEFAULT_TYPEWRITER_MS;

  private gesture = new GestureCommit();
  private teardown: Array<() => void> = [];

  /**
   * The selection the Animator card was armed for, or `null`.
   *
   * Keyed by the ids rather than a boolean reset on a property change, because
   * `option-text` hands over its array on every render and a reset keyed on
   * identity would close the card on any unrelated store write. Not a field on
   * the element: an armed card with nothing in it is where the user is
   * looking, and saving it would store a key for nothing.
   */
  private animatorArmedFor: string | null = null;

  createRenderRoot() {
    this.teardown.push(useTimelineStore.subscribe(() => this.requestUpdate()));
    // The timeline canvas's document-level mousedown clears the selection
    // before any button in here receives its own — so without this, clicking a
    // unit would act on nothing.
    this.setAttribute("data-keeps-selection", "");
    // A spinner drag abandoned with Escape. `onCancel` bubbles, so one listener
    // covers every field.
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

  private get primaryId(): string {
    return this.elementIds[0] ?? "";
  }

  private get element(): TimelineElement | null {
    return useTimelineStore.getState().timeline[this.primaryId] ?? null;
  }

  private get reveal(): TextReveal | null {
    return revealOf(this.element);
  }

  private get cursor(): number {
    return useTimelineStore.getState().cursor;
  }

  // --------------------------------------------------------------- writing

  /**
   * Pick a unit, or clear the reveal by picking the one it already has.
   *
   * The same gesture `optionMaskSection` gives its shapes, and for the same
   * reason: a separate "off" button in a row of three states is a fourth state
   * that is not one.
   */
  private handleUnit(unit: RevealUnit) {
    const ids = [...this.elementIds];
    const next = this.reveal?.unit === unit ? null : unit;
    useTimelineStore
      .getState()
      .withCheckpoint((doc) =>
        ids.reduce((acc, id) => setClipTextReveal(acc, id, next), doc),
      );
    this.requestUpdate();
  }

  /**
   * A field change, with its keyframe, as one undo step.
   *
   * The keyframe is written **only where the track is already switched on**,
   * which is what makes the progress box usable both as a static control and as
   * the animation's authoring surface without a mode switch. Written before the
   * static field so `setClipTextRevealFields` sees the document the keyframe
   * left, and the two cannot be undone apart.
   */
  private commitField(patch: RevealFieldPatch, key?: number) {
    const ids = [...this.elementIds];
    // `projectBakeHz()`, not the op's 60Hz default: a baked lane is a cache read by
    // nearest sample, so one written coarser than the project's rate hands
    // consecutive frames the same value and the curve steps. See
    // `keyframes.ts#bakeRateFor`.
    const bakeHz = projectBakeHz();
    this.gesture.apply((doc) => {
      let next = doc;
      for (const id of ids) {
        const element: any = next.elements[id];
        if (element == null) {
          continue;
        }
        if (key != null && element.animation?.revealProgress?.isActivate) {
          next = addKeyframe(
            next,
            id,
            "revealProgress",
            "x",
            this.cursor - element.startTime,
            key,
            undefined,
            bakeHz,
          );
        }
        next = setClipTextRevealFields(next, id, patch);
      }
      return next;
    });
    this.requestUpdate();
  }

  /**
   * Type every selected clip's text on, from the playhead where it is over the
   * clip and from the clip's start where it is not.
   *
   * `playheadAnchor` answers `undefined` when the cursor is off the clip, and
   * the panel takes that fallback rather than refusing — the rule
   * `animationPresetBrowser` follows. The agent command is the half that throws
   * instead, because an agent naming a time meant that time.
   */
  private handleTypewriter() {
    const ids = [...this.elementIds];
    const unit = this.reveal?.unit;
    const durationMs = this.typewriterMs;
    const bakeHz = projectBakeHz();
    useTimelineStore.getState().withCheckpoint((doc) =>
      ids.reduce((acc, id) => {
        const element = acc.elements[id];
        return applyTypewriter(acc, id, {
          unit,
          durationMs,
          startAtMs: playheadAnchor(element, this.cursor),
          bakeHz,
        });
      }, doc),
    );
    this.requestUpdate();
  }

  private get selectionKey(): string {
    return this.elementIds.join(",");
  }

  /** Whether the Animator card is open: the clip has one, or the eye was clicked. */
  private get animatorArmed(): boolean {
    return (
      hasAnimator(this.reveal) || this.animatorArmedFor === this.selectionKey
    );
  }

  /**
   * Arm the card, or take the movement off every selected clip.
   *
   * Off is `animate: null`, which keeps the reveal and its keyframes and drops
   * only the movement. Disarmed after the write, so the card closes on the
   * render that write causes rather than a frame later.
   */
  private handleAnimatorToggle() {
    if (!this.animatorArmed) {
      this.animatorArmedFor = this.selectionKey;
      this.requestUpdate();
      return;
    }
    const ids = [...this.elementIds];
    useTimelineStore
      .getState()
      .withCheckpoint((doc) =>
        ids.reduce(
          (acc, id) => setClipTextRevealFields(acc, id, { animate: null }),
          doc,
        ),
      );
    this.animatorArmedFor = null;
    this.requestUpdate();
  }

  /** A scrubbed animator box, through the same gesture the fields above use. */
  private commitAnimate(patch: Record<string, unknown>) {
    this.animatorArmedFor = this.selectionKey;
    this.commitField({ animate: patch });
  }

  /** A pick from the Easing dropdown: one change, one undo step. */
  private handleAnimateEasing(event: Event) {
    const ids = [...this.elementIds];
    const patch = animatorEasingPatch((event.target as HTMLSelectElement).value);
    this.animatorArmedFor = this.selectionKey;
    useTimelineStore
      .getState()
      .withCheckpoint((doc) =>
        ids.reduce(
          (acc, id) => setClipTextRevealFields(acc, id, { animate: patch }),
          doc,
        ),
      );
    this.requestUpdate();
  }

  /** The value out of one of the rows' `<number-input>`s. */
  private numberAt(event: Event): number {
    const value = (event.target as any)?.value;
    const parsed = typeof value === "string" ? parseFloat(value) : value;
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
  }

  // --------------------------------------------------------------- drawing

  private keyButton() {
    return html`
      <control-keyframe-nav
        .elementId=${this.primaryId}
        .property=${"revealProgress"}
        .label=${"reveal"}
      ></control-keyframe-nav>
    `;
  }

  /**
   * One named field. `title` is the label's tooltip, and `dim` draws the
   * controls quiet and out of reach for a field that cannot be written yet.
   */
  private row(
    label: string,
    inputs: unknown,
    keyed: boolean,
    title: string = label,
    dim = false,
  ) {
    return html`
      <div class="opt-field">
        <div class="opt-row">
          <label class="opt-label" title=${title}>${label}</label>
          <div
            class="opt-row-controls"
            style=${dim ? "opacity: 0.4; pointer-events: none;" : nothing}
            aria-disabled=${dim ? "true" : nothing}
          >
            ${inputs}${keyed ? this.keyButton() : ""}
          </div>
        </div>
      </div>
    `;
  }

  /** One animator box. Its range is the op's clamp; see `ANIMATOR_BOXES`. */
  private animatorInput(
    key: AnimatorMoveKey | "window",
    value: number,
    write: (next: number) => Record<string, unknown>,
  ) {
    const spec = ANIMATOR_BOXES[key];
    return html`
      <number-input
        aria-event="reveal-animate-${key}"
        .value=${value}
        min=${spec.min}
        max=${spec.max}
        step=${spec.step}
        sensitivity=${spec.sensitivity}
        @onChange=${(e: Event) => this.commitAnimate(write(this.numberAt(e)))}
      ></number-input>
    `;
  }

  /**
   * The Animator card's rows. Every value is where a unit **starts**; it
   * settles on the clip's own.
   */
  private animatorBody(reveal: TextReveal) {
    const values = animatorValuesOf(reveal);
    const moving = hasAnimator(reveal);
    const move = (key: AnimatorMoveKey) =>
      this.animatorInput(key, values[key], (next) =>
        animatorMovePatch(key, next),
      );
    const later = moving ? "" : " Takes effect once a unit moves.";

    return html`
      ${this.row(
        "Scale",
        move("scale"),
        false,
        "Size a unit starts at, in percent. 100 does not scale.",
      )}
      ${this.row(
        "Offset",
        html`${move("offsetX")}${move("offsetY")}`,
        false,
        "Where a unit starts, in pixels from where it lands. Positive Y is down.",
      )}
      ${this.row(
        "Rotation",
        move("rotation"),
        false,
        "Degrees a unit starts turned, about its own centre.",
      )}
      ${this.row("Blur", move("blur"), false, "Blur a unit starts at, in pixels.")}
      ${this.row(
        "Opacity",
        move("opacity"),
        false,
        "Opacity a unit starts at. 0 fades in; 100 does not fade.",
      )}
      ${this.row(
        "Overlap",
        this.animatorInput("window", values.window, animatorWindowPatch),
        false,
        "Units moving at once. 1 is one at a time; 3 staggers." + later,
        !moving,
      )}
      ${this.row(
        "Easing",
        html`
          <select
            class="opt-select"
            style="width: 112px;"
            aria-label="reveal easing"
            aria-event="reveal-animate-easing"
            ?disabled=${!moving}
            .value=${live(values.easing)}
            @change=${(e: Event) => this.handleAnimateEasing(e)}
          >
            ${animatorEasingOptions().map(
              (option) => html`
                <option
                  value=${option.value}
                  ?selected=${option.value === values.easing}
                >
                  ${option.label}
                </option>
              `,
            )}
          </select>
        `,
        false,
        "How a unit travels from where it starts to where it lands." + later,
        !moving,
      )}
    `;
  }

  render() {
    if (!isRevealable(this.element)) {
      return html``;
    }
    const reveal = this.reveal;

    // A closed choice of three, so one bordered group rather than three pills.
    const units = html`
      <div class="opt-field">
        <div class="opt-seg" role="group" aria-label="Reveal unit">
          ${REVEAL_UNITS.map(
            (unit) => html`
              <button
                type="button"
                class="opt-seg-item ${reveal?.unit === unit ? "is-on" : ""}"
                aria-event="reveal-unit-${unit}"
                aria-pressed=${reveal?.unit === unit ? "true" : "false"}
                title=${unit}
                @click=${() => this.handleUnit(unit)}
              >
                ${UNIT_LABEL[unit]}
              </button>
            `,
          )}
        </div>
      </div>
    `;

    const typewriter = html`
      <div class="opt-field d-flex flex-row gap-2 align-items-center">
        <button
          type="button"
          class="opt-text-btn"
          style="flex: 1 1 auto; justify-content: center;"
          aria-event="reveal-typewriter"
          title="Reveal one unit at a time, at this interval"
          @click=${() => this.handleTypewriter()}
        >
          <span class="material-symbols-outlined" style="font-size: 14px;"
            >keyboard</span
          >
          Typewriter
        </button>
        <number-input
          aria-event="reveal-typewriter-ms"
          .value=${this.typewriterMs}
          min="1"
          step="50"
          sensitivity="10"
          @onChange=${(e: Event) => {
            this.typewriterMs = Math.max(1, this.numberAt(e));
          }}
        ></number-input>
      </div>
    `;

    if (reveal == null) {
      return section({ title: "Reveal", body: html`${units}${typewriter}` });
    }

    const armed = this.animatorArmed;
    // Its own card rather than more rows under Softness: it is optional, it is
    // eight fields, and a reveal without it is the common case. Shown only
    // once there is a reveal, since a movement needs units to move.
    const animator = section({
      title: "Animator",
      actions: eyeButton(
        armed,
        armed ? "Stop animating each unit" : "Animate each unit as it appears",
        () => this.handleAnimatorToggle(),
        "reveal-animator-toggle",
      ),
      body: armed ? this.animatorBody(reveal) : undefined,
    });

    return html`${section({
      title: "Reveal",
      body: html`
        ${units}${typewriter}
        ${this.row(
          "Progress",
          html`
            <number-input
              aria-event="reveal-progress"
              .value=${reveal.progress}
              min="0"
              max="100"
              step="1"
              sensitivity="1"
              @onChange=${(e: Event) =>
                this.commitField(
                  { progress: this.numberAt(e) },
                  this.numberAt(e),
                )}
            ></number-input>
          `,
          true,
        )}
        ${this.row(
          "Softness",
          html`
            <number-input
              aria-event="reveal-fade"
              .value=${reveal.fade ?? 0}
              min="0"
              max="1"
              step="0.05"
              sensitivity="0.01"
              @onChange=${(e: Event) =>
                this.commitField({ fade: this.numberAt(e) })}
            ></number-input>
          `,
          false,
        )}
      `,
    })}${animator}`;
  }
}

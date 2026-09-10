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
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

import {
  REVEAL_UNITS,
  type RevealUnit,
  type TextReveal,
  type TimelineElement,
} from "../../@types/timeline";
import { KeyframeController } from "../../controllers/keyframe";
import { useTimelineStore } from "../../states/timelineStore";
import { addKeyframe } from "../animation/keyframeOps";
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
import "../../components/input/input";

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

  private keyframeControl = new KeyframeController(this);
  private gesture = new GestureCommit();
  private teardown: Array<() => void> = [];

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
    useTimelineStore.getState().withCheckpoint((doc) =>
      ids.reduce((acc, id) => {
        const element = acc.elements[id];
        return applyTypewriter(acc, id, {
          unit,
          durationMs,
          startAtMs: playheadAnchor(element, this.cursor),
        });
      }, doc),
    );
    this.requestUpdate();
  }

  /** The value out of one of the rows' `<number-input>`s. */
  private numberAt(event: Event): number {
    const value = (event.target as any)?.value;
    const parsed = typeof value === "string" ? parseFloat(value) : value;
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
  }

  private get trackActive(): boolean {
    return (
      (this.element as any)?.animation?.revealProgress?.isActivate === true
    );
  }

  private toggleTrack() {
    const element = this.element;
    if (element == null) {
      return;
    }
    this.keyframeControl.setActive({
      elementId: this.primaryId,
      animationType: "revealProgress",
      active: !this.trackActive,
      atMs: this.cursor - (element as any).startTime,
    });
    this.requestUpdate();
  }

  // --------------------------------------------------------------- drawing

  private keyButton() {
    return html`
      <button
        class="btn btn-xxs text-light mr-2"
        aria-event="reveal-key-progress"
        title="revealProgress"
        @click=${() => this.toggleTrack()}
      >
        <span
          class="material-symbols-outlined icon-xsm ${
            this.trackActive ? "text-light" : "text-secondary"
          }"
        >
          stat_0
        </span>
      </button>
    `;
  }

  private row(label: string, inputs: unknown, keyed: boolean) {
    return html`
      <label class="form-label text-light">${label}</label>
      <div class="d-flex flex-row justify-content-between bd-highlight mb-2">
        <div class="d-flex flex-row gap-2 justify-content-start">${inputs}</div>
        <div class="d-flex flex-row gap-2 justify-content-end">
          ${keyed ? this.keyButton() : ""}
        </div>
      </div>
    `;
  }

  render() {
    if (!isRevealable(this.element)) {
      return html``;
    }
    const reveal = this.reveal;

    const units = html`
      <div class="d-flex flex-row gap-1 mb-2">
        ${REVEAL_UNITS.map(
          (unit) => html`
            <button
              class="btn btn-xxs ${
                reveal?.unit === unit ? "btn-primary" : "btn-default"
              } text-light flex-fill"
              aria-event="reveal-unit-${unit}"
              title=${unit}
              @click=${() => this.handleUnit(unit)}
            >
              ${UNIT_LABEL[unit]}
            </button>
          `,
        )}
      </div>
    `;

    const typewriter = html`
      <div class="d-flex flex-row gap-2 mb-3 align-items-center">
        <button
          class="btn btn-xxs btn-default text-light flex-fill"
          aria-event="reveal-typewriter"
          @click=${() => this.handleTypewriter()}
        >
          <span class="material-symbols-outlined icon-xs">keyboard</span>
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
      return html`
        <div class="mt-2">
          <label class="form-label text-light">Reveal</label>
          ${units}${typewriter}
        </div>
      `;
    }

    return html`
      <div class="mt-2">
        <label class="form-label text-light">Reveal</label>
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
      </div>
    `;
  }
}

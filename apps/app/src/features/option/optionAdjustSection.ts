/**
 * The Adjust tab: a clip's fifteen colour sliders, in CapCut's three groups.
 *
 * One component included by all four clip inspectors, as `option-lut-section`
 * is. Every write goes through `timeline/adjustOps.ts`, the same ops the agent
 * command uses, and through `GestureCommit`, so a drag across a slider is one
 * undo step however many values it passed through.
 *
 * Takes a list of ids: with several clips selected it shows the first clip's
 * values and writes to all of them, which is how the mask section behaves.
 *
 * One section per group, each with its Reset in the head, which is the
 * arrangement every other section in the inspector has (`optionKit.ts`). Inside
 * a group the name and the value sit on one line and the slider runs full width
 * beneath, as CapCut lays it out: the inspector column is narrow, and a slider
 * sharing its line with a label and a number box was left about seventy pixels
 * to travel a range of two hundred.
 *
 * Double-clicking a slider's name puts it back to zero, which is Lightroom's
 * gesture and the one people reach for when they have lost track of where
 * neutral was.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

import {
  COLOR_ADJUSTMENT_KEYS,
  type ColorAdjustmentKey,
  type ColorAdjustments,
} from "../../@types/timeline";
import { LocaleController } from "../../controllers/locale";
import { useTimelineStore } from "../../states/timelineStore";
import {
  ADJUSTMENTS,
  ADJUST_GROUPS,
  type AdjustGroup,
  groupLabelKeyOf,
  keysOfGroup,
  labelKeyOf,
} from "../adjust/spec";
import { adjustOf } from "../renderer/adjust";
import type { TimelineDocument } from "../timeline/tracks";
import {
  isAdjustable,
  resetClipAdjustMany,
  setClipAdjustMany,
} from "../timeline/adjustOps";
import { GestureCommit } from "./gestureCommit";
import { sliderField, textButton } from "./optionKit";

/**
 * The two controls whose direction *is* a colour get a track that says so:
 * which way is warm, which way is magenta, without a label. Every other slider
 * keeps the stock track.
 *
 * Aimed at the row rather than at the input, so the slider itself needs no
 * class of its own and `optionKit`'s `sliderField` stays the only thing that
 * decides what a slider is made of. The row's own `[data-adjust]` outranks
 * `_option.scss`'s `input[type="range"].opt-slider`, which is what makes the
 * gradient stick.
 */
const TRACK_STYLES = `
  option-adjust-section [data-adjust="temperature"] input[type="range"]::-webkit-slider-runnable-track {
    background: linear-gradient(90deg, #3b7fd9, #bdbdbd 50%, #e8b33a);
  }
  option-adjust-section [data-adjust="tint"] input[type="range"]::-webkit-slider-runnable-track {
    background: linear-gradient(90deg, #3fae4f, #bdbdbd 50%, #c64fc0);
  }
`;

@customElement("option-adjust-section")
export class OptionAdjustSection extends LitElement {
  @property({ attribute: false })
  elementIds: string[] = [];

  private lc = new LocaleController(this);
  private gesture = new GestureCommit();
  private teardown: Array<() => void> = [];

  createRenderRoot() {
    this.teardown.push(useTimelineStore.subscribe(() => this.requestUpdate()));
    // Or the timeline canvas's document-level mousedown clears the selection
    // before the slider receives its own.
    this.setAttribute("data-keeps-selection", "");
    return this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    for (const off of this.teardown) {
      off();
    }
    this.teardown = [];
  }

  /** The ids that can carry adjustments, read from the store every render. */
  private get targets(): string[] {
    const timeline = useTimelineStore.getState().timeline;
    return this.elementIds.filter((id) => isAdjustable(timeline[id]));
  }

  private get values(): ColorAdjustments {
    const first = this.targets[0];
    return first == null
      ? {}
      : (adjustOf(useTimelineStore.getState().timeline[first]) ?? {});
  }

  /** A translated label, or the table's English when the locale has none. */
  private label(key: string, fallback: string): string {
    const text = this.lc.t(key);
    return text === "" ? fallback : text;
  }

  private scrub(key: ColorAdjustmentKey, value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }
    const ids = this.targets;
    this.gesture.apply((doc) => setClipAdjustMany(doc, ids, { [key]: value }));
    this.requestUpdate();
  }

  private commit = (): void => {
    this.gesture.flush();
    this.requestUpdate();
  };

  /** One immediate step, for a reset or a typed value. */
  private write(fn: (doc: TimelineDocument) => TimelineDocument): void {
    this.gesture.flush();
    useTimelineStore.getState().withCheckpoint(fn);
    this.requestUpdate();
  }

  private typed(key: ColorAdjustmentKey, value: number): void {
    const ids = this.targets;
    this.write((doc) => setClipAdjustMany(doc, ids, { [key]: value }));
  }

  private resetKey(key: ColorAdjustmentKey): void {
    const ids = this.targets;
    this.write((doc) => setClipAdjustMany(doc, ids, { [key]: 0 }));
  }

  private resetGroup(group?: AdjustGroup): void {
    const ids = this.targets;
    this.write((doc) => resetClipAdjustMany(doc, ids, group));
  }

  private renderRow(key: ColorAdjustmentKey, values: ColorAdjustments) {
    const spec = ADJUSTMENTS[key];
    const value = values[key] ?? 0;
    return html`
      <div class="opt-field" data-adjust=${key}>
        ${sliderField({
          label: this.label(labelKeyOf(key), spec.label),
          value,
          min: spec.min,
          max: spec.max,
          bipolar: spec.min < 0,
          dim: value === 0,
          labelTitle: this.label(
            "adjust.reset_hint",
            "Double-click a name to reset it.",
          ),
          onLabelDblClick: () => this.resetKey(key),
          onScrub: (next) => this.scrub(key, next),
          onCommit: this.commit,
          onTyped: (next) => this.typed(key, next),
          onInvalid: () => this.requestUpdate(),
        })}
      </div>
    `;
  }

  private renderGroup(group: AdjustGroup, values: ColorAdjustments) {
    const keys = keysOfGroup(group);
    const moved = keys.some((key) => (values[key] ?? 0) !== 0);
    // `data-adjust-group` on the card, so the group's Reset is the first button
    // inside it. `tests/e2e/specs/adjust-panel.spec.ts` clicks it by exactly
    // that description, and a collapse toggle added to this head would take the
    // position and silently reset nothing.
    return html`
      <div class="opt-section" data-adjust-group=${group}>
        <div class="opt-head">
          <span class="opt-head-title">
            ${this.label(groupLabelKeyOf(group), group)}
          </span>
          <div class="opt-head-actions">
            ${textButton({
              label: this.label("adjust.reset", "Reset"),
              disabled: !moved,
              onClick: () => this.resetGroup(group),
            })}
          </div>
        </div>
        <div class="opt-body">
          ${keys.map((key) => this.renderRow(key, values))}
        </div>
      </div>
    `;
  }

  render() {
    if (this.targets.length === 0) {
      return html``;
    }
    const values = this.values;
    const moved = COLOR_ADJUSTMENT_KEYS.some((key) => (values[key] ?? 0) !== 0);
    return html`
      <style>
        ${TRACK_STYLES}
      </style>
      ${ADJUST_GROUPS.map((group) => this.renderGroup(group, values))}
      <!--
        The last button in the component, which is how the e2e suite finds it.
        Anything added after this has to be something it can click without
        resetting the clip's grade.
      -->
      <button
        type="button"
        class="opt-text-btn"
        style="width: 100%; justify-content: center; height: 26px;"
        ?disabled=${!moved}
        @click=${() => this.resetGroup()}
      >
        ${this.label("adjust.reset_all", "Reset all")}
      </button>
    `;
  }
}

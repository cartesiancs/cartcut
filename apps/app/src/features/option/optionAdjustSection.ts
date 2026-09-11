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
 * Laid out as CapCut lays it out — the name and the value on one line, the
 * slider full width beneath. The inspector column is narrow, and a slider
 * sharing its line with a label and a number box was left about seventy
 * pixels to travel a range of two hundred.
 *
 * Double-clicking a slider's name puts it back to zero — Lightroom's gesture,
 * and the one people reach for when they have lost track of where neutral was.
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

/**
 * The two controls whose direction *is* a colour get a track that says so —
 * which way is warm, which way is magenta — without a label. Every other
 * slider keeps the stock track. Written as literal rules rather than through a
 * custom property, because a pseudo-element's background is the one place a
 * `var()` set on the input is easy to lose to the framework's own rule.
 */
const TRACK_STYLES = `
  option-adjust-section .adjust-range[data-track="temperature"]::-webkit-slider-runnable-track {
    background: linear-gradient(90deg, #3b7fd9, #bdbdbd 50%, #e8b33a);
  }
  option-adjust-section .adjust-range[data-track="tint"]::-webkit-slider-runnable-track {
    background: linear-gradient(90deg, #3fae4f, #bdbdbd 50%, #c64fc0);
  }
  option-adjust-section .adjust-range {
    display: block;
    width: 100%;
    height: 1.1rem;
    padding: 0;
    margin: 0;
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

  private resetKey(key: ColorAdjustmentKey): void {
    const ids = this.targets;
    this.write((doc) => setClipAdjustMany(doc, ids, { [key]: 0 }));
  }

  private resetGroup(group?: AdjustGroup): void {
    const ids = this.targets;
    this.write((doc) => resetClipAdjustMany(doc, ids, group));
  }

  private typed(key: ColorAdjustmentKey, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(value)) {
      this.requestUpdate();
      return;
    }
    const ids = this.targets;
    this.write((doc) => setClipAdjustMany(doc, ids, { [key]: value }));
  }

  private renderRow(key: ColorAdjustmentKey, values: ColorAdjustments) {
    const spec = ADJUSTMENTS[key];
    const value = values[key] ?? 0;
    const bipolar = spec.min < 0;
    const coloured = key === "temperature" || key === "tint";
    return html`
      <div class="mb-2" data-adjust=${key}>
        <div class="d-flex align-items-center justify-content-between" style="gap: 8px;">
          <label
            class="text-light text-truncate mb-0"
            style="font-size: 11px; cursor: default; user-select: none;
                   ${value === 0 ? "opacity: 0.65;" : ""}"
            title=${this.label("adjust.reset_hint", "Double-click a name to reset it.")}
            @dblclick=${() => this.resetKey(key)}
          >
            ${this.label(labelKeyOf(key), spec.label)}
          </label>
          <input
            type="number"
            class="form-control form-control-sm bg-default text-light text-end px-1 py-0 flex-shrink-0"
            style="width: 3.8em; font-size: 11px; height: 20px;"
            min=${String(spec.min)}
            max=${String(spec.max)}
            step="1"
            .value=${String(Math.round(value))}
            @change=${(e: Event) => this.typed(key, e)}
          />
        </div>
        <div class="position-relative mt-1">
          ${bipolar
            ? html`<span
                aria-hidden="true"
                style="position: absolute; left: 50%; top: 50%; width: 1px; height: 12px;
                       transform: translate(-50%, -50%); background: #ffffff66;
                       pointer-events: none;"
              ></span>`
            : ""}
          <input
            type="range"
            class="form-range adjust-range"
            data-track=${coloured ? key : ""}
            min=${String(spec.min)}
            max=${String(spec.max)}
            step="1"
            .value=${String(value)}
            @input=${(e: Event) => this.scrub(key, Number((e.target as HTMLInputElement).value))}
            @change=${this.commit}
          />
        </div>
      </div>
    `;
  }

  private renderGroup(group: AdjustGroup, values: ColorAdjustments) {
    const keys = keysOfGroup(group);
    const moved = keys.some((key) => (values[key] ?? 0) !== 0);
    return html`
      <div class="mb-3" data-adjust-group=${group}>
        <div class="d-flex align-items-center mb-2">
          <span class="text-light fw-semibold flex-grow-1" style="font-size: 12px;">
            ${this.label(groupLabelKeyOf(group), group)}
          </span>
          <button
            class="btn btn-xs btn-default text-light ${moved ? "" : "invisible"}"
            style="font-size: 10px;"
            @click=${() => this.resetGroup(group)}
          >
            ${this.label("adjust.reset", "Reset")}
          </button>
        </div>
        ${keys.map((key) => this.renderRow(key, values))}
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
      <div class="mt-1">
        ${ADJUST_GROUPS.map((group) => this.renderGroup(group, values))}
        <button
          class="btn btn-sm btn-default text-light w-100 mb-3"
          style="font-size: 11px;"
          ?disabled=${!moved}
          @click=${() => this.resetGroup()}
        >
          ${this.label("adjust.reset_all", "Reset all")}
        </button>
      </div>
    `;
  }
}

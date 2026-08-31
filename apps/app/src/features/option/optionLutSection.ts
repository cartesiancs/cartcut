/**
 * The LUT row inside a clip's inspector.
 *
 * One component included by all five clip inspectors rather than five copies of
 * the same three controls — which is what `Gradable` being a mixin over exactly
 * those five types means in the UI.
 *
 * Deliberately *not* a preset picker. Choosing a look is a visual decision made
 * against eighty thumbnails in the LUT panel; a dropdown of eighty names is
 * a worse version of that and would invite people to pick by name. What belongs
 * here is what the panel cannot show: which LUT this clip currently has, how
 * strongly it applies, and how to take it off.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

import type { LutRef, TimelineElement } from "../../@types/timeline";
import { selectionStore } from "../../states/selectionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { presetById } from "../fx/presetRegistry";
import { lutOf } from "../renderer/lut";
import {
  isGradable,
  setClipLut,
  setClipLutIntensity,
} from "../timeline/lutOps";
import { GestureCommit } from "./gestureCommit";

@customElement("option-lut-section")
export class OptionLutSection extends LitElement {
  @property({ type: String })
  elementId = "";

  private gesture = new GestureCommit();
  private teardown: Array<() => void> = [];

  createRenderRoot() {
    this.teardown.push(
      useTimelineStore.subscribe(() => this.requestUpdate()),
      selectionStore.subscribe(() => this.requestUpdate()),
    );
    // Or the timeline canvas's document-level mousedown clears the selection
    // before the slider receives its own mousedown.
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

  /** Read from the store every render, never cached — see `optionVideo`. */
  private get element(): TimelineElement | null {
    return useTimelineStore.getState().timeline[this.elementId] ?? null;
  }

  private get ref(): LutRef | null {
    return lutOf(this.element);
  }

  private handleScrub = (event: Event): void => {
    const value = Number((event.target as HTMLInputElement).value);
    const id = this.elementId;
    // Through `GestureCommit`, so a drag across the whole slider collapses into
    // one undo step rather than a hundred.
    this.gesture.apply((doc) => setClipLutIntensity(doc, id, value));
    this.requestUpdate();
  };

  private handleCommit = (): void => {
    this.gesture.flush();
    this.requestUpdate();
  };

  private handleClear = (): void => {
    const id = this.elementId;
    useTimelineStore
      .getState()
      .withCheckpoint((doc) => setClipLut(doc, id, null));
    this.requestUpdate();
  };

  render() {
    if (!isGradable(this.element)) {
      return html``;
    }
    const ref = this.ref;
    const preset = ref == null ? null : presetById(ref.presetId);

    return html`
      <div class="mt-2">
        <span class="text-secondary" style="font-size: 11px;">LUT</span>
        ${ref == null
          ? html`<div class="text-secondary" style="font-size: 11px;">
              None
            </div>`
          : html`
              <div class="d-flex align-items-center gap-2 mt-1">
                <span
                  class="text-light flex-grow-1"
                  style="font-size: 11px; white-space: nowrap;
                         overflow: hidden; text-overflow: ellipsis;"
                  title=${ref.presetId}
                >
                  ${preset?.name ??
                  // A project can name a LUT this machine does not have. It
                  // renders ungraded and says so, rather than looking like the
                  // LUT simply stopped working.
                  `${ref.presetId} (not installed)`}
                </span>
                <button
                  class="btn btn-sm btn-outline-secondary"
                  style="font-size: 11px;"
                  @click=${this.handleClear}
                >
                  Remove
                </button>
              </div>
              <div class="d-flex align-items-center gap-2">
                <input
                  type="range"
                  class="form-range"
                  min="0"
                  max="100"
                  step="1"
                  .value=${String(ref.intensity)}
                  @input=${this.handleScrub}
                  @change=${this.handleCommit}
                />
                <span
                  class="text-secondary"
                  style="font-size: 11px; width: 3ch; text-align: right;"
                >
                  ${Math.round(ref.intensity)}
                </span>
              </div>
            `}
      </div>
    `;
  }
}

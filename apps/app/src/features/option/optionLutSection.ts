/**
 * The LUT section inside a clip's inspector.
 *
 * One component included by all five clip inspectors rather than five copies of
 * the same three controls, which is what `Gradable` being a mixin over exactly
 * those five types means in the UI.
 *
 * Deliberately *not* a preset picker. Choosing a look is a visual decision made
 * against eighty thumbnails in the LUT panel; a dropdown of eighty names is a
 * worse version of that and would invite people to pick by name. What belongs
 * here is what the panel cannot show: which LUT this clip currently has, how
 * strongly it applies, and how to take it off.
 *
 * So this is the shape every choose-one section in the inspector takes: the name
 * at one end of the head and a `+` at the other, which opens the grid the choice
 * is actually made in. With one chosen, the `+` becomes the way to take it off
 * and the body carries what there is to adjust.
 *
 * Nothing in here may say "filter": `VideoElementType.filter` already owns that
 * word for the chroma key and the blurs, and `tests/e2e/specs/lut-panel.spec.ts`
 * reads this component's text and every title in it to hold that line.
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
import { iconButton, section, sliderField } from "./optionKit";

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

  private handleScrub = (value: number): void => {
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

  private handleTyped = (value: number): void => {
    const id = this.elementId;
    this.gesture.flush();
    useTimelineStore
      .getState()
      .withCheckpoint((doc) => setClipLutIntensity(doc, id, value));
    this.requestUpdate();
  };

  private handleClear = (): void => {
    const id = this.elementId;
    useTimelineStore
      .getState()
      .withCheckpoint((doc) => setClipLut(doc, id, null));
    this.requestUpdate();
  };

  /**
   * Take the user to the grid the choice is made in.
   *
   * Two steps, because they are two different switches: the sidebar pill opens
   * the Fx tab through Bootstrap's own delegated handler, and `openPanel` picks
   * which of that tab's three grids is showing. Clicking the pill alone lands on
   * whichever grid was last looked at.
   *
   * Both lookups are `document.querySelector` against a tag, which is how the
   * rest of this codebase reaches across components. `global.d.ts` widens its
   * return to `any`, so neither result is typed and neither is asserted to be
   * there: the column is reachable with no Fx tab at all.
   */
  private handleBrowse = (): void => {
    document.querySelector('[data-bs-target="#nav-fx"]')?.click?.();
    document.querySelector("control-ui-fx")?.openPanel?.("lut");
  };

  render() {
    if (!isGradable(this.element)) {
      return html``;
    }
    const ref = this.ref;
    const preset = ref == null ? null : presetById(ref.presetId);

    if (ref == null) {
      return section({
        title: "LUT",
        actions: iconButton({
          icon: "add",
          title: "Browse LUTs",
          onClick: this.handleBrowse,
        }),
      });
    }

    return section({
      title: "LUT",
      actions: iconButton({
        icon: "close",
        title: "Remove",
        onClick: this.handleClear,
      }),
      body: html`
        <div class="opt-field">
          <span class="opt-chip" title=${ref.presetId}>
            ${preset?.name ??
            // A project can name a LUT this machine does not have. It renders
            // ungraded and says so, rather than looking like the LUT simply
            // stopped working.
            `${ref.presetId} (not installed)`}
          </span>
        </div>
        <div class="opt-field">
          ${sliderField({
            label: "Intensity",
            suffix: "%",
            value: ref.intensity,
            min: 0,
            max: 100,
            onScrub: this.handleScrub,
            onCommit: this.handleCommit,
            onTyped: this.handleTyped,
            onInvalid: () => this.requestUpdate(),
          })}
        </div>
      `,
    });
  }
}

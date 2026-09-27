/**
 * The Media / Animation / Mask switch at the top of a clip's inspector.
 *
 * The option column has never had a tab bar — panels simply stacked, and a
 * masked clip would have added eleven more controls to the bottom of a list
 * that already runs off the screen. The idiom is `ui/control/ControlFx.ts`'s,
 * which is the only hand-rolled toggle in the app and the only one that does
 * not depend on Bootstrap's own JS: a `@state` field, a `data-panel` attribute
 * for tests to aim at, and panes that stay **mounted** and hide with `d-none`.
 *
 * Staying mounted is the load-bearing part, and it is not for speed. Every
 * control in both panes subscribes to the document when it mounts, and tearing
 * one down on each toggle would drop and re-add those subscriptions on a
 * control the user is clicking between — which is the failure
 * `tests/e2e/specs/lut-panel.spec.ts` documents from the other direction.
 *
 * This component renders only the buttons. The panes belong to the inspector
 * that owns them, because it is the one that knows what is in them.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

export type OptionTab = "media" | "adjust" | "mask" | "animation";

/** One button. `id` is whatever the owning inspector wants to switch on. */
export interface OptionTabSpec {
  id: string;
  label: string;
  icon: string;
}

/**
 * The clip inspectors' four, and the default when no list is given.
 *
 * Adjust sits next to Media because it is the other half of "how this clip
 * looks": Media holds the LUT, Adjust holds the corrections made before it.
 */
const CLIP_TABS: OptionTabSpec[] = [
  { id: "media", label: "Media", icon: "movie" },
  { id: "adjust", label: "Adjust", icon: "tune" },
  { id: "animation", label: "Animation", icon: "animation" },
  { id: "mask", label: "Mask", icon: "crop" },
];

@customElement("option-tab-bar")
export class OptionTabBar extends LitElement {
  @property({ type: String })
  active: string = "media";

  /**
   * Which buttons to draw.
   *
   * Defaulted rather than required, because the four clip inspectors all want
   * the same three and said so by not passing anything. `ControlSetting` is
   * the one caller with a different pair — it describes the project rather than
   * a clip, so Media/Mask/Animation mean nothing there — and it passes its own.
   */
  @property({ attribute: false })
  tabs: OptionTabSpec[] = CLIP_TABS;

  createRenderRoot() {
    // The timeline canvas clears the selection on any document mousedown that
    // is not opted out, and it fires before the click — so switching tabs with
    // a clip selected would land on nothing.
    this.setAttribute("data-keeps-selection", "");
    return this;
  }

  private select(tab: string) {
    if (tab === this.active) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("tab-change", { detail: tab, bubbles: true, composed: true }),
    );
  }

  render() {
    // Four tabs do not fit the column at its stock width: the fourth ran off
    // the edge and the third was cut to "Animati", and shrinking the label only
    // traded that for "M.." and "A..". So the bar is a size container, and
    // below the width where four names fit each tab is its icon with the name
    // as a tooltip. A container query rather than a media query, because what
    // decides it is the column, which the user can resize, not the window.
    //
    // Three or fewer keep their names at every width (`opt-tabs-few`): the
    // query asks about the whole bar, so it would hide a two-tab bar's names in
    // a column where they fit.
    //
    // `option-tabs-crowded` and `option-tab-label` earn their place by being
    // what `tests/e2e/specs/adjust-panel.spec.ts` measures: it sizes the
    // container by that class and counts the labels that are displayed.
    const crowded = this.tabs.length > 3;
    return html`
      <div
        class="opt-tabs ${crowded ? "option-tabs-crowded" : "opt-tabs-few"}"
      >
        <div class="opt-tabs-row d-flex">
          ${this.tabs.map(
            (tab) => html`
              <button
                type="button"
                class="opt-tab ${this.active === tab.id ? "is-on" : ""}"
                data-panel=${tab.id}
                title=${tab.label}
                aria-label=${tab.label}
                aria-selected=${this.active === tab.id ? "true" : "false"}
                @click=${() => this.select(tab.id)}
              >
                <span class="material-symbols-outlined">${tab.icon}</span>
                <span class="option-tab-label opt-tab-label">${tab.label}</span>
              </button>
            `,
          )}
        </div>
      </div>
    `;
  }
}

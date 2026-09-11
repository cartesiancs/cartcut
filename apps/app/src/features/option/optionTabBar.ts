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
    // Four clip tabs do not fit a narrow inspector column at the stock size,
    // and `.btn` is `nowrap`: the fourth ran off the edge and the third was cut
    // to "Animati". Shrinking and truncating the label only traded that for
    // "M··" and "A··" — at the harness's window size each button is about 32
    // CSS pixels, and no label fits in that.
    //
    // So past three tabs the bar is a size container. The buttons share the
    // row equally and may shrink (`min-width: 0`); below the width where four
    // names fit, each is a legible icon with its name as a tooltip, and above
    // it the name sits under the icon. A container query rather than a media
    // query, because what matters is the column, which the user can resize,
    // not the window.
    //
    // Only past three. The project settings bar passes two and draws its icon
    // and label inline; it keeps exactly the markup it had.
    const crowded = this.tabs.length > 3;
    if (!crowded) {
      return html`
        <div class="d-flex gap-1 mb-2">
          ${this.tabs.map(
            (tab) => html`
              <button
                class="btn btn-xs ${this.active === tab.id
                  ? "btn-primary"
                  : "btn-default"} text-light flex-fill"
                data-panel=${tab.id}
                @click=${() => this.select(tab.id)}
              >
                <span class="material-symbols-outlined icon-xs">${tab.icon}</span>
                ${tab.label}
              </button>
            `,
          )}
        </div>
      `;
    }
    return html`
      <style>
        option-tab-bar .option-tabs-crowded {
          container-type: inline-size;
        }
        option-tab-bar .option-tabs-crowded .option-tab-icon {
          font-size: 16px;
          line-height: 1;
        }
        option-tab-bar .option-tabs-crowded .option-tab-label {
          display: none;
          font-size: 11px;
        }
        @container (min-width: 280px) {
          option-tab-bar .option-tabs-crowded .option-tab-icon {
            font-size: x-small;
          }
          option-tab-bar .option-tabs-crowded .option-tab-label {
            display: block;
          }
        }
      </style>
      <div class="option-tabs-crowded mb-2">
        <div class="d-flex gap-1">
          ${this.tabs.map(
            (tab) => html`
              <button
                class="btn btn-xs ${this.active === tab.id
                  ? "btn-primary"
                  : "btn-default"} text-light flex-fill"
                style="min-width: 0; flex-basis: 0;"
                data-panel=${tab.id}
                title=${tab.label}
                aria-label=${tab.label}
                @click=${() => this.select(tab.id)}
              >
                <span class="material-symbols-outlined option-tab-icon text-light"
                  >${tab.icon}</span
                >
                <span class="option-tab-label text-truncate">${tab.label}</span>
              </button>
            `,
          )}
        </div>
      </div>
    `;
  }
}

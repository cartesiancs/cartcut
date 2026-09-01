/**
 * The Media / Mask switch at the top of a clip's inspector.
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

export type OptionTab = "media" | "mask";

const TABS: Array<{ id: OptionTab; label: string; icon: string }> = [
  { id: "media", label: "Media", icon: "movie" },
  { id: "mask", label: "Mask", icon: "crop" },
];

@customElement("option-tab-bar")
export class OptionTabBar extends LitElement {
  @property({ type: String })
  active: OptionTab = "media";

  createRenderRoot() {
    // The timeline canvas clears the selection on any document mousedown that
    // is not opted out, and it fires before the click — so switching tabs with
    // a clip selected would land on nothing.
    this.setAttribute("data-keeps-selection", "");
    return this;
  }

  private select(tab: OptionTab) {
    if (tab === this.active) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("tab-change", { detail: tab, bubbles: true, composed: true }),
    );
  }

  render() {
    return html`
      <div class="d-flex gap-1 mb-2">
        ${TABS.map(
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
}

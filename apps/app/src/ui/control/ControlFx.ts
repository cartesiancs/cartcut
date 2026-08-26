/**
 * The "Fx" sidebar tab: effect and transition presets, in one place.
 *
 * One tab with an internal toggle rather than two sidebar entries. The sidebar
 * is a 2.5rem column that already carries six icons, and both halves are the
 * same act — picking a preset out of a grid — so splitting them would cost a
 * slot to save a click. `control-ui-filter` established the pattern of
 * switching panels inside one tab; this follows it, with the difference that
 * both panels here actually exist.
 *
 * The grid itself is `<fx-preset-browser>`, reused with a different `kind`.
 */

import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import "../../features/fx/fxPresetBrowser";

type FxPanel = "effect" | "transition";

@customElement("control-ui-fx")
export class ControlUiFx extends LitElement {
  @state()
  private activePanel: FxPanel = "effect";

  createRenderRoot() {
    return this;
  }

  private select(panel: FxPanel) {
    this.activePanel = panel;
  }

  private tab(panel: FxPanel, label: string) {
    return html`
      <button
        class="btn btn-sm ${this.activePanel === panel
          ? "btn-primary"
          : "btn-default"} text-light mt-1"
        @click=${() => this.select(panel)}
      >
        ${label}
      </button>
    `;
  }

  render() {
    return html`
      <div class="d-flex gap-2 px-2">
        ${this.tab("effect", "Effects")} ${this.tab("transition", "Transitions")}
      </div>

      <div class="mt-2">
        <!--
          Both grids stay mounted and one is hidden, rather than being torn
          down and rebuilt on every toggle. Each subscribes to the selection
          and the document when it mounts, and remounting would drop and re-add
          those subscriptions on a control the user is clicking between.
        -->
        <div class=${this.activePanel === "effect" ? "" : "d-none"}>
          <fx-preset-browser kind="effect"></fx-preset-browser>
        </div>
        <div class=${this.activePanel === "transition" ? "" : "d-none"}>
          <fx-preset-browser kind="transition"></fx-preset-browser>
        </div>
      </div>
    `;
  }
}

/**
 * The "Fx" sidebar tab: effect, transition and LUT presets, in one place.
 *
 * One tab with an internal toggle rather than three sidebar entries. The
 * sidebar is a 2.5rem column that already carries six icons, and all three
 * halves are the same act — picking a preset out of a grid — so splitting them
 * would cost a slot each to save a click. `control-ui-filter` established the
 * pattern of switching panels inside one tab; this follows it, with the
 * difference that every panel here actually exists.
 *
 * LUTs used to sit next to this tab rather than inside it, on the argument that
 * a LUT is a different question — "change how the picture looks" rather than
 * "add an element" — and is reached first rather than last. That is retired:
 * three grids that are browsed identically read better as three toggles than as
 * two icons a user has to learn the difference between, and the column has the
 * slot back.
 *
 * The grids are `<fx-preset-browser>`, reused with a different `kind`, and
 * `<lut-browser>`, which is its own component because what a click *does*
 * differs — a LUT grades the selected clips, it does not add an element.
 */

import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import "../../features/fx/fxPresetBrowser";
import "../../features/lut/lutBrowser";

type FxPanel = "effect" | "transition" | "lut";

@customElement("control-ui-fx")
export class ControlUiFx extends LitElement {
  @state()
  private activePanel: FxPanel = "effect";

  createRenderRoot() {
    // The tab bar is chrome that acts on the selection: `elementTimelineCanvas`
    // clears it on any document mousedown, which fires *before* the click, so
    // without this switching to LUTs with clips selected would land on nothing
    // and the next tile would add an adjustment layer instead of grading them.
    // `closest()` walks up, so one attribute here covers every button.
    this.setAttribute("data-keeps-selection", "");
    return this;
  }

  private select(panel: FxPanel) {
    this.activePanel = panel;
  }

  /**
   * `btn-xs` and `flex-fill`, not the `btn-sm` two tabs used to wear.
   *
   * The sidebar column is about 430px wide and `overflow-x` is hidden on the
   * pane, so a third button at the old size does not shrink — it is simply cut
   * off the right edge and cannot be clicked. Three equal shares at 11px fit,
   * and 11px is the size the rest of both grids' copy already uses.
   */
  private tab(panel: FxPanel, label: string) {
    return html`
      <button
        class="btn btn-xs ${this.activePanel === panel
          ? "btn-primary"
          : "btn-default"} text-light mt-1 flex-fill"
        data-panel=${panel}
        @click=${() => this.select(panel)}
      >
        ${label}
      </button>
    `;
  }

  render() {
    return html`
      <div class="d-flex gap-1 px-2">
        ${this.tab("effect", "Effects")} ${this.tab("transition", "Transitions")}
        ${this.tab("lut", "LUTs")}
      </div>

      <div class="mt-2">
        <!--
          Every grid stays mounted and the others are hidden, rather than being
          torn down and rebuilt on every toggle. Each subscribes to the selection
          and the document when it mounts, and remounting would drop and re-add
          those subscriptions on a control the user is clicking between.
        -->
        <div class=${this.activePanel === "effect" ? "" : "d-none"}>
          <fx-preset-browser kind="effect"></fx-preset-browser>
        </div>
        <div class=${this.activePanel === "transition" ? "" : "d-none"}>
          <fx-preset-browser kind="transition"></fx-preset-browser>
        </div>
        <div class=${this.activePanel === "lut" ? "" : "d-none"}>
          <lut-browser></lut-browser>
        </div>
      </div>
    `;
  }
}

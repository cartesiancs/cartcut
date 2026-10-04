/**
 * The "Fx" sidebar tab: effect, transition, graphic and LUT presets, in one place.
 *
 * One tab with an internal toggle rather than four sidebar entries. The
 * sidebar is a 2.5rem column that already carries six icons, and all four
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
 * The look is shared rather than owned: the toggle is the inspector's tab
 * track and everything under it is `_browse.scss` over the file browser's
 * tiles, so the three grids read as the same panel the asset list is.
 *
 * The grids are `<fx-preset-browser>`, reused with a different `kind`, and
 * `<lut-browser>`, which is its own component because what a click *does*
 * differs — a LUT grades the selected clips, it does not add an element.
 */

import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import "../../features/fx/fxPresetBrowser";
import "../../features/lut/lutBrowser";

type FxPanel = "effect" | "transition" | "graphic" | "lut";

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
   * Show one of the grids, from outside.
   *
   * The inspector's LUT section offers a `+` that has to land the user on the
   * grid, and the sidebar pill alone only opens this tab: without this it would
   * open on whichever grid was last looked at, which for a first-time click is
   * Effects.
   */
  openPanel(panel: FxPanel) {
    this.select(panel);
  }

  /**
   * One cell of the inspector's own tab track (`.opt-tabs` in `_option.scss`),
   * so the sidebar and the inspector switch panes with the same control.
   *
   * Four equal shares that never clip: the column is about 430px at its stock
   * width and `overflow-x` is hidden on the pane, so a button that does not
   * shrink is cut off the right edge and cannot be clicked. `opt-tabs-few`
   * keeps the names at every width, and `_browse.scss` drops the glyphs first
   * when the column is narrower than the four of them need.
   *
   * The LUT glyph is `palette` and nothing called `filter_*`:
   * `lut-panel.spec.ts` reads this button's text, ligature included, and
   * refuses the word.
   */
  private tab(panel: FxPanel, label: string, icon: string) {
    const on = this.activePanel === panel;
    return html`
      <button
        type="button"
        class="opt-tab ${on ? "is-on" : ""}"
        data-panel=${panel}
        title=${label}
        aria-selected=${on ? "true" : "false"}
        @click=${() => this.select(panel)}
      >
        <span class="material-symbols-outlined">${icon}</span>
        <span class="opt-tab-label">${label}</span>
      </button>
    `;
  }

  render() {
    return html`
      <div class="opt-tabs opt-tabs-few browse-tabs" role="tablist">
        <div class="opt-tabs-row">
          ${this.tab("effect", "Effects", "auto_awesome")}
          ${this.tab("transition", "Transitions", "transition_fade")}
          ${this.tab("graphic", "Graphics", "title")}
          ${this.tab("lut", "LUTs", "palette")}
        </div>
      </div>

      <div>
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
        <div class=${this.activePanel === "graphic" ? "" : "d-none"}>
          <fx-preset-browser kind="graphic"></fx-preset-browser>
        </div>
        <div class=${this.activePanel === "lut" ? "" : "d-none"}>
          <lut-browser></lut-browser>
        </div>
      </div>
    `;
  }
}

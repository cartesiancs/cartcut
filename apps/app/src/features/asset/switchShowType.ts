import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { AssetShowType, IAssetStore, assetStore } from "../../states/assetStore";
import { LocaleController } from "../../controllers/locale";

/**
 * The file browser's grid / list switch, as a two-cell segmented control
 * (`_browse.scss#browse-seg`).
 *
 * Both modes are always drawn and the current one is raised. The single button
 * this replaced showed the current mode's glyph and meant "switch to the other
 * one", so what it showed and what it did were never the same thing.
 */
@customElement("switch-showtype")
export class SwitchShowType extends LitElement {
  @property()
  assetState: IAssetStore = assetStore.getState();

  @property()
  showType = this.assetState.showType;

  private lc = new LocaleController(this);

  createRenderRoot() {
    assetStore.subscribe((state) => {
      this.showType = state.showType;
    });

    return this;
  }

  private cell(type: AssetShowType, icon: string, label: string) {
    const on = this.showType == type;
    return html`<button
      type="button"
      class="browse-seg-item ${on ? "is-on" : ""}"
      title=${label}
      aria-label=${label}
      aria-pressed=${on ? "true" : "false"}
      @click=${() => this.assetState.setShowType(type)}
    >
      <span class="material-symbols-outlined">${icon}</span>
    </button>`;
  }

  render() {
    return html`<div class="browse-seg" role="group">
      ${this.cell("grid", "grid_view", this.lc.t("setting.view_grid"))}
      ${this.cell("list", "view_list", this.lc.t("setting.view_list"))}
    </div>`;
  }
}

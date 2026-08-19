import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { IAssetStore, assetStore } from "../../states/assetStore";

@customElement("switch-showtype")
export class SwitchShowType extends LitElement {
  @property()
  assetState: IAssetStore = assetStore.getState();

  @property()
  showType = this.assetState.showType;

  createRenderRoot() {
    assetStore.subscribe((state) => {
      this.showType = state.showType;
    });

    return this;
  }

  render() {
    return html` <button
        ref="arrowup"
        class="btn btn-transparent btn-sm ${this.showType == "list"
          ? ""
          : "d-none"}"
        @click=${this._handleClickSwitchShowType}
      >
        <span class="material-symbols-outlined icon-sm"> view_list </span>
      </button>
      <button
        ref="arrowup"
        class="btn btn-transparent btn-sm ${this.showType == "grid"
          ? ""
          : "d-none"}"
        @click=${this._handleClickSwitchShowType}
      >
        <span class="material-symbols-outlined icon-sm"> grid_view </span>
      </button>`;
  }

  _handleClickSwitchShowType() {
    this.assetState.toggleShowType();
  }
}

import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { AssetController } from "../../controllers/asset";
import { getLocationEnv } from "../../functions/getLocationEnv";
import "./switchShowType";

@customElement("asset-browser")
export class AssetBrowser extends LitElement {
  directory: string;
  constructor() {
    super();

    this.directory = "";
  }

  createRenderRoot() {
    return this;
  }

  private assetControl = new AssetController();

  render() {
    return html`<div class="d-flex flex-row p-0 mt-2">
        <button
          ref="arrowup"
          class="btn btn-transparent btn-sm"
          @click=${this.clickPrevDirectoryButton}
        >
          <span class="material-symbols-outlined icon-sm"> arrow_upward </span>
        </button>
        <input
          ref="text"
          type="text"
          class="form-control"
          aria-describedby="basic-addon1"
          value=""
          disabled
        />

        <switch-showtype></switch-showtype>
      </div>

      <asset-list></asset-list> `;
  }

  updateDirectoryInput(path) {
    const root: HTMLDivElement | null = this.querySelector("div");
    if (root == null) {
      return false;
    }
    let directoryInput: any = root.querySelector("input[ref='text']");
    directoryInput.value = path;

    if (getLocationEnv() == "web") {
      localStorage.setItem("targetDirectory", path);
    }
  }

  clickPrevDirectoryButton() {
    this.directory = document.querySelector("asset-list").nowDirectory;
    if (this.directory == "") {
      return 0;
    }

    let splitNowDirectory = this.directory.split("/");
    let splitPrevDirectory = splitNowDirectory.slice(
      -splitNowDirectory.length,
      -1,
    );

    this.assetControl.requestAllDir(splitPrevDirectory.join("/"));
  }
}

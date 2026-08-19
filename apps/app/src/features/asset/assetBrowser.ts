import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { AssetController } from "../../controllers/asset";
import { getLocationEnv } from "../../functions/getLocationEnv";
import { IAssetStore, assetStore } from "../../states/assetStore";
import { projectStore } from "../../states/projectStore";
import { LocaleController } from "../../controllers/locale";
import {
  AssetEntry,
  joinPath,
  parentDirectory,
  readDirectory,
} from "./directoryEntries";
import "./switchShowType";
import "./assetList";

type LoadStatus = "idle" | "loading" | "loaded" | "error";

/**
 * Opens the folder picker and points both the project root and the browse
 * cursor at the result.
 *
 * Lives here rather than in `functions/directory.ts` so that everything which
 * decides "what is the asset panel showing" sits in one file. `ControlSetting`
 * imports it for its own "select project folder" button.
 */
export async function selectProjectFolder(): Promise<void> {
  if (getLocationEnv() == "demo") {
    const toast: any = document.querySelector("toast-box");
    toast?.showToast({
      message: "The folder cannot be viewed in the demo version.",
      delay: "3000",
    });
    return;
  }

  const picked = await window.electronAPI.req.dialog.openDirectory();

  let dir = "/";
  if (getLocationEnv() == "web") {
    // The web shim has no real picker, so the last visited folder is the only
    // thing worth reopening.
    dir = localStorage.getItem("targetDirectory") || "/";
  } else {
    dir = String(picked || "/");
  }

  projectStore.getState().updateProjectFolder(dir);

  // Kept in sync for `event.ts`, `Modal.ts` and `ControlRender.ts`, which still
  // read the project root off this input.
  const projectFolderInput: any = document.querySelector("#projectFolder");
  if (projectFolderInput != null) {
    projectFolderInput.value = dir;
  }

  assetStore.getState().setDirectory(dir);
}

@customElement("asset-browser")
export class AssetBrowser extends LitElement {
  @state()
  nowDirectory = assetStore.getState().nowDirectory;

  @state()
  entries: AssetEntry[] = [];

  @state()
  status: LoadStatus = "idle";

  @state()
  errorMessage = "";

  @state()
  showType = assetStore.getState().showType;

  private lc = new LocaleController(this);
  private assetControl = new AssetController();
  private unsubscribe?: () => void;
  private loadedRevision = assetStore.getState().directoryRevision;

  createRenderRoot() {
    this.unsubscribe = assetStore.subscribe((state: IAssetStore) => {
      this.showType = state.showType;

      if (state.directoryRevision != this.loadedRevision) {
        this.loadedRevision = state.directoryRevision;
        this.nowDirectory = state.nowDirectory;
        this.loadDirectory(state.nowDirectory, state.directoryRevision);
      }
    });

    return this;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
  }

  private async loadDirectory(dir: string, revision: number) {
    if (dir == "") {
      this.entries = [];
      this.status = "idle";
      return;
    }

    this.status = "loading";
    this.errorMessage = "";

    try {
      const entries = await readDirectory(dir);

      // A faster click may have already asked for somewhere else; that request
      // owns the panel now, so this reply is dropped rather than painted.
      if (this.isStale(revision)) {
        return;
      }

      this.entries = entries;
      this.status = "loaded";

      if (getLocationEnv() == "web") {
        localStorage.setItem("targetDirectory", dir);
      }
    } catch (error) {
      if (this.isStale(revision)) {
        return;
      }

      this.entries = [];
      this.status = "error";
      this.errorMessage =
        error instanceof Error ? error.message : String(error);
    }
  }

  private isStale(revision: number): boolean {
    return assetStore.getState().directoryRevision != revision;
  }

  render() {
    return html`<div class="d-flex flex-row p-0 mt-2">
        <button
          ref="arrowup"
          class="btn btn-transparent btn-sm"
          @click=${this.handleClickPrevDirectory}
        >
          <span class="material-symbols-outlined icon-sm"> arrow_upward </span>
        </button>
        <input
          ref="text"
          type="text"
          class="form-control"
          aria-describedby="basic-addon1"
          .value=${this.nowDirectory}
          disabled
        />

        <switch-showtype></switch-showtype>
      </div>

      <div @asset-navigate=${this.handleNavigate} @asset-open=${this.handleOpen}>
        ${this.templateBody()}
      </div>`;
  }

  private templateBody() {
    if (this.status == "idle") {
      return this.templateEmpty();
    }

    if (this.status == "error") {
      return html`<p class="text-light mt-2 text-center">
        ${this.errorMessage || "Could not read this folder."}
      </p>`;
    }

    return html`<asset-list
      .entries=${this.entries}
      .directory=${this.nowDirectory}
      .showType=${this.showType}
    ></asset-list>`;
  }

  private templateEmpty() {
    const isDemo = getLocationEnv() == "demo";

    return html`<div class="row px-2">
      <p class="text-light mt-2 text-center">
        ${isDemo
          ? "The folder cannot be viewed in the demo version."
          : this.lc.t("setting.need_select_project_folder")}
      </p>
      <button
        class="btn btn-sm btn-default text-light ${isDemo ? "d-none" : ""}"
        @click=${this.handleClickSelectFolder}
      >
        ${this.lc.t("setting.select_project_folder")}
      </button>
    </div>`;
  }

  private handleClickSelectFolder() {
    selectProjectFolder();
  }

  private handleNavigate(event: CustomEvent) {
    const target = joinPath(this.nowDirectory, event.detail.name);
    assetStore.getState().setDirectory(target);
  }

  private handleOpen(event: CustomEvent) {
    this.assetControl.add(event.detail.path);
  }

  private handleClickPrevDirectory() {
    const parent = parentDirectory(this.nowDirectory);
    if (parent == null) {
      return;
    }

    assetStore.getState().setDirectory(parent);
  }
}

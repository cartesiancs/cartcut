import { LitElement, PropertyValues, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { atPlayhead, importPathsAt } from "./importDrop";
import { pickWebMedia } from "../mobile/deviceImport";
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
import { AssetSort, sortAssetEntries } from "./assetSort";
import {
  importedMediaStore,
  type ImportedMedia,
} from "./webMedia/importedMedia";
import { cloudStore, subscribeCloudListing } from "../cloud/cloudStore";
import {
  cascade,
  prefersReducedMotion,
  viewOf,
  type CascadeRun,
} from "../motion/cascade";
import {
  BROWSE_MOTION,
  hideStep,
  revealStep,
} from "../motion/browseMotion";
import "./switchShowType";
import "./assetList";
import "./assetSortMenu";
import "../cloud/cloudAssetGrid";

type LoadStatus = "idle" | "loading" | "loaded" | "error";

/**
 * Opens the folder picker and points both the project root and the browse
 * cursor at the result.
 *
 * Lives here rather than in `functions/directory.ts` so that everything which
 * decides "what is the asset panel showing" sits in one file. `ControlSetting`
 * imports it for its own "select project folder" button.
 *
 * The same function serves the empty state and the toolbar button, so changing
 * folder later is the identical action to picking the first one. Nothing on the
 * timeline moves: a clip holds an absolute `localpath`, and `projectFolder` is
 * only where renders are written.
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

  let dir = "";
  if (getLocationEnv() == "web") {
    // The web shim has no real picker, so the last visited folder is the only
    // thing worth reopening.
    dir = localStorage.getItem("targetDirectory") || "/";
  } else {
    // Cancelling the dialog answers `undefined`. Leave the panel exactly where
    // it was: this is offered from an already open folder now, and the old
    // `picked || "/"` threw the user out to the filesystem root for pressing
    // Escape.
    if (!picked) {
      return;
    }

    dir = String(picked);
  }

  projectStore.getState().updateProjectFolder(dir);

  // The `#projectFolder` input this used to mirror into is gone with the
  // settings panel's own picker, and nothing reads it any more — `event.ts` and
  // `Modal.ts`, the two the mirror existed for, both stopped. `projectStore`
  // above is the one answer to "where is the project" now.

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

  @state()
  sort: AssetSort = assetStore.getState().sort;

  /**
   * Showing the cloud's free media instead of the folder. Never remembered:
   * the panel always opens on the user's own files, and the folder view stays
   * mounted underneath so its tutorial targets and its scroll survive.
   *
   * This is what the cloud button asks for, and it flips on the click. The
   * two after it are where the panel has got to: a switch takes them one step
   * at a time (`browseMotion.ts` has the order), so for its length the three
   * disagree on purpose.
   */
  @state()
  private cloudView = false;

  /** The bar in its cloud shape: the search open, the folder's controls away. */
  @state()
  private cloudBar = false;

  /** The folder's controls and list out of the layout, and the cloud grid in it. */
  @state()
  private cloudShown = false;

  /** When the cloud grid's first tiles may show, on `performance.now()`'s clock. */
  private revealFrom = 0;

  /** Bumped by every switch, so a step still waiting knows it was overtaken. */
  private switchEpoch = 0;
  private swapTimer = 0;
  /** The fade on the folder's controls and list, entering or leaving. */
  private localFade: Animation[] = [];
  /** The cloud's tiles leaving, while they are. */
  private cloudHide: CascadeRun | null = null;

  @state()
  private cloudQuery = "";

  private unsubscribeCloud?: () => void;

  /**
   * `entries` in `sort`'s order, recomputed in `willUpdate` when either
   * changes. A new sort re-orders what was read and never reads the disk.
   */
  private sorted: AssetEntry[] = [];

  /**
   * A browser build's imported files (`importedMedia.ts`), shown above the
   * folder in their own section. Always empty in Electron, where a picked
   * file has a real path and lives in a real folder.
   */
  @state()
  private imported: readonly ImportedMedia[] = importedMediaStore.getState().items;

  /** `imported` in `sort`'s order, recomputed with `sorted`. */
  private importedSorted: AssetEntry[] = [];

  private unsubscribeImported?: () => void;

  private lc = new LocaleController(this);
  private unsubscribe?: () => void;
  private observer?: IntersectionObserver;
  private loadedRevision = assetStore.getState().directoryRevision;

  /**
   * Whether this panel has ever been on screen.
   *
   * It mounts at app startup inside a `display: none` tab pane and Lit has no
   * reason to re-render when the pane is finally shown, so without this the
   * folder is read, and every `lstat` in it issued, for a session that never
   * opens the Asset tab. The same gate `templateBrowser`, `lutBrowser` and
   * `animationPresetBrowser` each carry, and for the same reason.
   *
   * The tiles gate themselves separately, so this is not what stops the
   * expensive half; it is what stops the disk read.
   */
  private seen = false;

  createRenderRoot() {
    this.unsubscribe = assetStore.subscribe((state: IAssetStore) => {
      this.showType = state.showType;
      // Replaced only on a real change, so Lit's identity check is the whole
      // test for whether to re-sort.
      this.sort = state.sort;

      if (state.directoryRevision != this.loadedRevision) {
        this.loadedRevision = state.directoryRevision;
        this.nowDirectory = state.nowDirectory;
        // Remembered, not dropped: opening the tab later loads whatever the
        // cursor has arrived at by then.
        if (this.seen) {
          this.loadDirectory(state.nowDirectory, state.directoryRevision);
        }
      }
    });

    this.unsubscribeImported = importedMediaStore.subscribe((state) => {
      if (state.items === this.imported) {
        return;
      }
      this.imported = state.items;
      // What was just imported is what the user wants to see, and the cloud
      // grid would be covering it.
      if (this.cloudView) {
        void this.switchToLocal();
      }
    });

    // The cloud button follows the setting, and turning the setting off from
    // inside the cloud view puts the folder back.
    this.unsubscribeCloud = subscribeCloudListing(() => {
      if ((this.cloudView || this.cloudBar) && !this.cloudOffered()) {
        this.resetCloud();
      }
      this.requestUpdate();
    });

    return this;
  }

  /** Whether the cloud button is there at all: a bridge, and the setting on. */
  private cloudOffered(): boolean {
    const state = cloudStore.getState();
    return state.available && state.enabled;
  }

  private handleToggleCloud() {
    if (this.cloudView) {
      void this.switchToLocal();
    } else {
      this.switchToCloud();
    }
  }

  /**
   * Into the cloud: the folder fades where it stands while the field starts
   * opening (`_browse.scss`, on `is-cloud`), then the folder leaves the layout
   * and the cloud grid arrives in its place, its tiles cascading in as the
   * field finishes.
   */
  private switchToCloud() {
    const epoch = ++this.switchEpoch;
    this.cloudView = true;

    // Caught on the way out, with the cloud's tiles still leaving: they turn
    // round where they are, and nothing else has moved yet.
    if (this.cloudHide != null) {
      this.cloudHide.reverse();
      this.cloudHide = null;
      return;
    }

    const reduced = prefersReducedMotion();
    this.cloudBar = true;
    this.fadeLocal("out", reduced ? 0 : BROWSE_MOTION.outMs, 0);

    window.clearTimeout(this.swapTimer);
    this.swapTimer = window.setTimeout(
      () => {
        this.swapTimer = 0;
        if (epoch != this.switchEpoch) {
          return;
        }
        // Before the swap, so the grid measures its tiles against the top of
        // the pane it will be seen at.
        this.closest(".tab-content")?.scrollTo({ top: 0 });
        this.revealFrom =
          performance.now() + (reduced ? 0 : BROWSE_MOTION.revealLeadMs);
        this.cloudShown = true;
        // `display: none` from this render on, so the faded-out frame the
        // fade holds has nothing left to hold.
        void this.updateComplete.then(() => {
          if (epoch == this.switchEpoch) {
            this.dropLocalFade();
          }
        });
      },
      reduced ? 0 : BROWSE_MOTION.outMs,
    );
  }

  /**
   * Back to the folder, in the reverse order: the cloud's tiles leave up the
   * panel, then the field closes into the button as the folder fades back.
   */
  private async switchToLocal() {
    const epoch = ++this.switchEpoch;
    this.cloudView = false;
    const reduced = prefersReducedMotion();

    // Caught while the folder was still fading out: nothing of the cloud is
    // on screen yet, so the folder fades back from where it got to.
    if (!this.cloudShown) {
      window.clearTimeout(this.swapTimer);
      this.swapTimer = 0;
      this.cloudBar = false;
      this.fadeLocal("in", reduced ? 0 : BROWSE_MOTION.inMs, 0);
      return;
    }

    const grid = this.querySelector("cloud-asset-grid");
    const run = cascade(
      grid?.querySelectorAll<HTMLElement>("[data-cascade]") ?? [],
      viewOf(this.closest(".tab-content")),
      hideStep(reduced),
    );
    this.cloudHide = run;
    await run.finished;

    // Turned round by a click on the way out (`switchToCloud` reversed the
    // run): the tiles are back, and the cloud view stays.
    if (epoch != this.switchEpoch) {
      run.cancel();
      return;
    }

    this.cloudHide = null;
    this.closest(".tab-content")?.scrollTo({ top: 0 });
    this.cloudBar = false;
    this.cloudShown = false;
    await this.updateComplete;
    if (epoch != this.switchEpoch) {
      return;
    }
    // From nothing: until this render they were `display: none`, so what
    // they show now is their resting opacity, not where a fade left them.
    this.fadeLocal(
      "in",
      reduced ? 0 : BROWSE_MOTION.inMs,
      reduced ? 0 : BROWSE_MOTION.inDelayMs,
      "0",
    );
  }

  /** Straight to the folder, with nothing animated: the cloud went away under us. */
  private resetCloud() {
    ++this.switchEpoch;
    window.clearTimeout(this.swapTimer);
    this.swapTimer = 0;
    this.cloudHide?.cancel();
    this.cloudHide = null;
    this.dropLocalFade();
    this.cloudView = false;
    this.cloudBar = false;
    this.cloudShown = false;
  }

  /**
   * Fade the folder's controls and list out, or back to their resting
   * opacity, from wherever each one is now (`from` overrides that).
   *
   * Back to *resting*, not to 1: the up button at the root is `:disabled` at
   * 0.4, so the way in is one keyframe at the start and the end left to the
   * stylesheet, and nothing is held once it is there. The way out is held at
   * 0 until the swap takes the elements out of the layout.
   */
  private fadeLocal(
    direction: "out" | "in",
    durationMs: number,
    delayMs: number,
    from?: string,
  ) {
    const targets = Array.from(
      this.querySelectorAll<HTMLElement>("[data-browse-local]"),
    );
    // Every read before the first write, so the previous fade is still
    // applied when its current value is taken.
    const starts = targets.map(
      (element) => from ?? getComputedStyle(element).opacity,
    );
    this.dropLocalFade();
    this.localFade = targets.map((element, i) =>
      element.animate(
        direction == "out"
          ? [{ opacity: starts[i] }, { opacity: 0 }]
          : [{ opacity: starts[i], offset: 0 }],
        {
          duration: durationMs,
          delay: delayMs,
          easing: "ease-out",
          fill: direction == "out" ? "forwards" : "backwards",
        },
      ),
    );
  }

  private dropLocalFade() {
    for (const animation of this.localFade) {
      animation.cancel();
    }
    this.localFade = [];
  }

  connectedCallback(): void {
    super.connectedCallback();

    this.observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }
      this.observer?.disconnect();
      this.observer = undefined;

      this.seen = true;
      const state = assetStore.getState();
      this.nowDirectory = state.nowDirectory;
      this.loadDirectory(state.nowDirectory, state.directoryRevision);
    });
    this.observer.observe(this);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.unsubscribeCloud?.();
    this.unsubscribeImported?.();
    this.observer?.disconnect();
    this.observer = undefined;
    ++this.switchEpoch;
    window.clearTimeout(this.swapTimer);
    this.swapTimer = 0;
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

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("entries") || changed.has("sort")) {
      this.sorted = sortAssetEntries(this.entries, this.sort);
    }
    if (changed.has("imported") || changed.has("sort")) {
      this.importedSorted = sortAssetEntries([...this.imported], this.sort);
    }
  }

  /**
   * A new order starts at the top: "Largest First" is a request to see the
   * largest file, and the row it is on is the first one. The first render is
   * not a change of order, so it leaves the pane where it was.
   */
  protected updated(changed: PropertyValues): void {
    if (changed.has("sort") && changed.get("sort") !== undefined) {
      this.closest(".tab-content")?.scrollTo({ top: 0 });
    }

    // A folder that has just been read, and only that: a new order or the
    // other view of the same folder moves tiles that were already there.
    if (changed.has("entries") && this.status == "loaded") {
      void this.revealEntries();
    }
  }

  /**
   * Cascade the folder's tiles in, top first.
   *
   * After the list *and* every tile in it have rendered: until a tile has, it
   * is a host with no well in it, a few pixels tall, and every row below the
   * first measures at the wrong height. All of it is microtasks, so the tiles
   * are hidden for their turn before any frame paints them.
   */
  private async revealEntries() {
    // The folder's list, not the Imported section's above it.
    const list = this.querySelector<LitElement>("asset-list[data-folder-list]");
    if (list == null) {
      return;
    }
    await list.updateComplete;
    const tiles = Array.from(
      list.querySelectorAll<LitElement>("asset-file, asset-folder"),
    );
    await Promise.all(tiles.map((tile) => tile.updateComplete));
    cascade(
      tiles,
      viewOf(this.closest(".tab-content")),
      revealStep(prefersReducedMotion()),
    );
  }

  render() {
    // The folder's own controls and list, hidden rather than removed in the
    // cloud view. Out of the layout only once their fade is over, and inert
    // from the click, so a control fading out cannot be pressed on its way.
    const local = this.cloudShown ? "d-none" : "";
    const away = this.cloudBar;
    const cloudLabel = this.cloudView
      ? this.lc.t("setting.local_assets")
      : this.lc.t("setting.cloud_assets");

    return html`<div class="browse-bar is-floating ${this.cloudBar ? "is-cloud" : ""}">
        ${this.cloudOffered()
          ? html`<label class="browse-field browse-search" ?inert=${!this.cloudBar}>
              <span class="material-symbols-outlined browse-field-icon">search</span>
              <input
                type="search"
                class="browse-input"
                spellcheck="false"
                placeholder=${this.lc.t("setting.cloud_search")}
                .value=${this.cloudQuery}
                @input=${(e: Event) =>
                  (this.cloudQuery = (e.target as HTMLInputElement).value)}
              />
            </label>`
          : ""}

        <button
          type="button"
          class="browse-btn ${local}"
          data-browse-local
          ?inert=${away}
          title=${this.lc.t("setting.parent_folder")}
          aria-label=${this.lc.t("setting.parent_folder")}
          ?disabled=${parentDirectory(this.nowDirectory) == null}
          @click=${this.handleClickPrevDirectory}
        >
          <span class="material-symbols-outlined">arrow_upward</span>
        </button>

        ${this.templatePath(local, away)}

        <button
          type="button"
          class="browse-btn ${getLocationEnv() == "demo" ? "d-none" : local}"
          data-browse-local
          ?inert=${away}
          data-tutorial="asset-change-folder"
          title=${this.lc.t("setting.change_project_folder")}
          aria-label=${this.lc.t("setting.change_project_folder")}
          @click=${this.handleClickSelectFolder}
        >
          <span class="material-symbols-outlined">folder_open</span>
        </button>

        ${getLocationEnv() == "electron"
          ? ""
          : html`<button
              type="button"
              class="browse-btn ${local}"
              data-browse-local
              ?inert=${away}
              title="Import files"
              aria-label="Import files"
              @click=${pickWebMedia}
            >
              <span class="material-symbols-outlined">upload_file</span>
            </button>`}

        <asset-sort-menu
          class=${local}
          data-browse-local
          ?inert=${away}
        ></asset-sort-menu>

        <switch-showtype
          class=${local}
          data-browse-local
          ?inert=${away}
        ></switch-showtype>

        ${this.cloudOffered()
          ? html`<button
              type="button"
              class="browse-btn browse-cloud"
              aria-pressed=${this.cloudView ? "true" : "false"}
              title=${cloudLabel}
              aria-label=${cloudLabel}
              @click=${this.handleToggleCloud}
            >
              <span class="material-symbols-outlined">cloud</span>
            </button>`
          : ""}
      </div>

      <div
        class=${local}
        data-browse-local
        ?inert=${away}
        @asset-navigate=${this.handleNavigate}
        @asset-open=${this.handleOpen}
      >
        ${this.templateBody()}
      </div>
      ${this.cloudShown
        ? html`<cloud-asset-grid
            .query=${this.cloudQuery.trim().toLowerCase()}
            .revealFrom=${this.revealFrom}
          ></cloud-asset-grid>`
        : ""}`;
  }

  /**
   * Where the panel is, as a path whose folder name is the part that shows.
   *
   * A read-only field in the search box's shell rather than a disabled
   * `<input>`: an input clips the end of its value, which is the folder's own
   * name, and `_browse.scss#browse-path` clips the start instead. The whole
   * path is the tooltip.
   */
  private templatePath(hidden = "", away = false) {
    // No folder yet: the shell alone, since the empty state under it already
    // says what to do and saying it twice reads as two different problems.
    const path = this.nowDirectory;
    if (path == "") {
      return html`<div
        class="browse-field browse-field-path ${hidden}"
        data-browse-local
        ?inert=${away}
      >
        <span class="material-symbols-outlined browse-field-icon">folder</span>
      </div>`;
    }

    // Split after the last separator that has something after it, so a root
    // ("/", "C:\") still shows as itself rather than as an empty leaf.
    const trimmed = path.replace(/[\\/]+$/, "");
    const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    const leaf = cut < 0 ? path : trimmed.slice(cut + 1) || path;
    const parent = cut < 0 ? "" : trimmed.slice(0, cut + 1);

    return html`<div
      class="browse-field browse-field-path ${hidden}"
      data-browse-local
      ?inert=${away}
      title=${path}
    >
      <span class="material-symbols-outlined browse-field-icon">folder</span>
      <span class="browse-path"
        ><bdi dir="ltr"
          >${parent}<span class="browse-path-leaf">${leaf}</span></bdi
        ></span
      >
    </div>`;
  }

  /**
   * The Imported section, or nothing while there is nothing imported. Its
   * tiles carry their own `blob:` paths, so a click and a drag out of it reach
   * `handleOpen` and the timeline's asset drop exactly as a folder's do.
   */
  private templateImported() {
    if (this.importedSorted.length == 0) {
      return nothing;
    }

    return html`<section class="browse-section browse-imported">
      <div class="browse-section-head">
        <span class="browse-section-title">Imported</span>
        <span class="browse-section-count">${this.importedSorted.length}</span>
      </div>
      <asset-list
        .entries=${this.importedSorted}
        .directory=${""}
        .showType=${this.showType}
        .sort=${this.sort}
      ></asset-list>
    </section>`;
  }

  private templateBody() {
    const imported = this.templateImported();

    if (this.status == "idle") {
      // Nothing to ask for while there are files to show: the empty state
      // under them would read as though the import had not worked.
      return imported === nothing ? this.templateEmpty() : imported;
    }

    if (this.status == "error") {
      return html`${imported}<div class="browse-empty">
        <div class="browse-empty-icon">
          <span class="material-symbols-outlined">folder_off</span>
        </div>
        <div class="browse-empty-title">Could not read this folder</div>
        <div class="browse-empty-text">${this.errorMessage}</div>
      </div>`;
    }

    return html`${imported}<asset-list
      data-folder-list
      .entries=${this.sorted}
      .directory=${this.nowDirectory}
      .showType=${this.showType}
      .sort=${this.sort}
    ></asset-list>`;
  }

  private templateEmpty() {
    const isDemo = getLocationEnv() == "demo";

    // A `<button>` with the label as its text: `tests/e2e/harness/ui.ts` finds
    // it as `asset-browser button` by "Select Folder".
    return html`<div class="browse-empty">
      <div class="browse-empty-icon">
        <span class="material-symbols-outlined">folder_open</span>
      </div>
      <div class="browse-empty-title">
        ${isDemo
          ? "The folder cannot be viewed in the demo version."
          : this.lc.t("setting.need_select_project_folder")}
      </div>
      <button
        type="button"
        class="browse-text-btn is-primary ${isDemo ? "d-none" : ""}"
        data-tutorial="asset-select-folder"
        @click=${this.handleClickSelectFolder}
      >
        ${this.lc.t("setting.select_project_folder")}
      </button>
      ${getLocationEnv() == "electron"
        ? ""
        : html`<button
            type="button"
            class="browse-text-btn ${isDemo ? "is-primary" : ""}"
            @click=${pickWebMedia}
          >
            Import files
          </button>`}
    </div>`;
  }

  private handleClickSelectFolder() {
    selectProjectFolder();
  }

  private handleNavigate(event: CustomEvent) {
    const target = joinPath(this.nowDirectory, event.detail.name);
    assetStore.getState().setDirectory(target);
  }

  /**
   * Opening an asset puts it on the timeline at the playhead.
   *
   * `importPathsAt` is where the drag out of this same panel already lands
   * (`elementTimelineCanvas`'s `"asset"` drop intent), and clicking has to
   * agree with dragging. It also has to go through `probeMedia`, because that
   * is the only reader that measures a file whose container states no length: a
   * `MediaRecorder` capture answers `duration: Infinity`, and a clip with an
   * infinite span is drawn by nothing, since every Canvas2D call with a
   * non-finite argument is a silent no-op.
   */
  private handleOpen(event: CustomEvent) {
    void importPathsAt([event.detail.path], atPlayhead());
  }

  private handleClickPrevDirectory() {
    const parent = parentDirectory(this.nowDirectory);
    if (parent == null) {
      return;
    }

    assetStore.getState().setDirectory(parent);
  }
}

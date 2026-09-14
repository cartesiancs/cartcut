import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import "./ControlSetting";
import "./ControlText";
import "./ControlExtension";
import "./ControlUtilities";
import "./ControlFilter";
import "./ControlFx";
import "./ControlTemplate";
import "../../features/preview/previewTopBar";
import "../../features/preview/previewBottomBar";
import "../../features/record/screenRecord";
import "../../features/record/audioRecord";
import "../../features/track/autoTrackPanel";
import "../../features/window/windowHost";

import "../../../../automatic-caption/src/automaticCaption";

import { IUIStore, uiStore } from "../../states/uiStore";
import { TimelineController } from "../../controllers/timeline";
import {
  IControlPanelStore,
  controlPanelStore,
} from "../../states/controlPanelStore";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import {
  applyCaptionCommit,
  mintCaptionIds,
} from "../../features/caption/applyCaptions";
import { planCuts } from "../../features/caption/cuts";
import { clipsAcrossCuts } from "../../features/timeline/rippleMap";
import { snapMsToFrame } from "../../features/timeline/frames";
import { commit } from "../../features/agent/commit";
import { LocaleController } from "../../controllers/locale";
import { windowStore } from "../../features/window/windowStore";
import type { WindowPanel } from "../../features/window/windowHost";

@customElement("control-ui")
export class Control extends LitElement {
  private lc = new LocaleController(this);

  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property()
  timeline: any = this.timelineState.timeline;

  @property()
  uiState: IUIStore = uiStore.getInitialState();

  @property()
  resize = this.uiState.resize;

  @property()
  isOptionPanelActive = this.uiState.isOptionPanelActive;

  @property()
  isAbleResize: boolean = false;

  @property()
  targetResize: "panel" | "preview" = "panel";

  @property()
  controlPanel: IControlPanelStore = controlPanelStore.getInitialState();

  @property()
  activePanel = this.controlPanel.active;

  @property()
  nowActivePanel = this.controlPanel.nowActive;

  /**
   * The project's frame, for the auto-caption panel.
   *
   * Passed down rather than read there, because `apps/automatic-caption/`
   * resolves its packages from its own `node_modules` and reaching
   * `renderOptionStore` would make it depend on zustand. The panel lays its
   * captions out in these pixels and previews them at this size, which is what
   * makes its preview and the placed element the same picture.
   */
  @property()
  previewSize = renderOptionStore.getInitialState().options.previewSize;

  @property()
  backgroundColor = renderOptionStore.getInitialState().options.backgroundColor;

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
    });

    renderOptionStore.subscribe((state) => {
      this.previewSize = state.options.previewSize;
      this.backgroundColor = state.options.backgroundColor;
    });

    uiStore.subscribe((state) => {
      this.resize = state.resize;
      this.isOptionPanelActive = state.isOptionPanelActive;
    });

    controlPanelStore.subscribe((state) => {
      this.activePanel = state.active;
      this.nowActivePanel = state.nowActive;
    });

    window.addEventListener("mouseup", this._handleMouseUp.bind(this));
    window.addEventListener("mousemove", this._handleMouseMove.bind(this));

    return this;
  }

  _handleMouseMove(e) {
    if (!this.isAbleResize) {
      return;
    }

    const elementControlComponent = document.querySelector("element-control");
    const windowWidth = window.innerWidth - this.resize.chatSidebar;
    const nowX = e.clientX;
    const resizeX = (nowX / windowWidth) * 100;

    // `HORIZONTAL_LIMITS` in the store is the single owner of how far a column
    // may go, so a drag past an edge pins there instead of being turned away by
    // a bound duplicated here.
    this.uiState.updateHorizontal(resizeX, this.targetResize);
    elementControlComponent.resizeEvent();
  }

  _handleMouseUp() {
    this.isAbleResize = false;
  }

  _handleClickResizePanel() {
    this.targetResize = "panel";
    this.isAbleResize = true;
  }

  _handleClickResizePreview() {
    this.targetResize = "preview";
    this.isAbleResize = true;
  }

  /**
   * Cut the footage the user struck out, and place what is left.
   *
   * The transcript timestamps the *source file*, so each caption's start has to
   * be mapped through the clip it came from, trim offset and speed included,
   * before it can be placed. Captions used to carry a `parentKey` and be
   * rendered at `parent.startTime + own.startTime`, which was the same
   * conversion done implicitly, at draw time, forever, and only for a 1x
   * untrimmed clip. Doing it once leaves every caption an ordinary clip holding
   * an absolute time, so many of them share one text track.
   *
   * This was a loop of `control.addText`, one store commit and one undo step per
   * caption. That is no longer survivable: the same gesture now removes footage,
   * and a Cmd+Z that took back one caption while leaving the cuts in place would
   * be worse than useless. `applyCaptionCommit` is the whole thing as one
   * document transform, and `commit` records exactly one step for it.
   *
   * Everything decided here is decided somewhere testable: `planCuts` owns the
   * conversion and the snapping, `applyCaptionCommit` owns the order. What is
   * left is reading the store, minting ids and warning the user.
   */
  _handleComplateAutoCaption(e) {
    const rows = e.detail.result ?? [];
    const sourceKey = e.detail.sourceKey ?? null;
    const sourceCuts = e.detail.cuts ?? [];

    const doc = useTimelineStore.getState().getDocument();
    const source = sourceKey ? doc.elements[sourceKey] : undefined;
    const fps = renderOptionStore.getState().options.fps;

    // Snapped here rather than inside the pure module, which must not read a
    // store. The grid is the same one the mouse is held to.
    const plan = planCuts(sourceCuts, source, (ms) => snapMsToFrame(ms, fps));

    // Refusing the cuts and keeping the captions is the recoverable half: the
    // user gets their transcript and can cut by hand. Cutting would leave an
    // empty track and nothing to undo back to but the checkpoint.
    const cuts = plan.coversWholeClip ? [] : plan.cuts;
    if (plan.coversWholeClip) {
      this.toastCaption(
        "Those cuts would remove the whole clip, so nothing was cut. The captions were placed.",
      );
    }

    if (cuts.length > 0 && sourceKey != null) {
      // The ripple is lane-local, so anything already sitting on another row
      // keeps its old timing and drifts out of sync with the speech. Said
      // plainly rather than discovered at playback.
      const stranded = clipsAcrossCuts(doc, source?.trackId ?? "", cuts);
      if (stranded.length > 0) {
        this.toastCaption(
          `${stranded.length} clip(s) on other tracks overlap the cuts and were not moved, so they may now be out of sync.`,
        );
      }
    }

    if (cuts.length === 0 && rows.length === 0) {
      return;
    }

    commit(
      (d) =>
        applyCaptionCommit(d, {
          sourceKey,
          cuts,
          rows,
          // Minted outside the transform: `commit` runs it twice, once to probe
          // whether it declines, and ids made inside would differ between the
          // two runs.
          ids: mintCaptionIds(rows.length, cuts.length),
        }),
      "Nothing to place, and nothing to cut.",
    );
  }

  private toastCaption(message: string) {
    (document.querySelector("toast-box") as any)?.showToast({
      message,
      delay: "6000",
    });
  }

  _handleChangeCursorType(e) {
    const type = e.detail.type;

    this.timelineState.setCursorType(type);
  }

  /**
   * What the preview column is able to dock beside itself.
   *
   * Declared here rather than in the window system because only this component
   * can build the content and name it in the user's language. A panel listed
   * here is not open: opening one is a write to `windowStore`, which is what
   * `ControlUtilities` does.
   */
  private _windowPanels(): WindowPanel[] {
    return [
      {
        id: "automaticCaption",
        label: this.lc.t("window.automatic_caption") || "Automatic Caption",
        icon: "subtitles",
        content: html`<automatic-caption
          .timeline=${this.timeline}
          .previewSize=${this.previewSize}
          .backgroundColor=${this.backgroundColor}
          .isDev=${false}
          @editComplate=${this._handleComplateAutoCaption}
          @changeCursorType=${this._handleChangeCursorType}
        ></automatic-caption>`,
      },
    ];
  }

  /**
   * Finishing an edit puts the window away.
   *
   * Apply and the title bar's close both reach `closeEditor`, so both end with
   * the preview holding the whole column again. Leaving the window open on the
   * "Load video" screen after an Apply would read as the edit not having been
   * taken.
   */
  private _handleCaptionEditorClose() {
    windowStore.getState().close("automaticCaption");
  }

  /**
   * Give the keyboard back when the caption window is closed from its title bar.
   *
   * The panel scopes its own `lockKeyboard` to focus and releases it on
   * `focusout`, but closing the window unmounts the panel, and an event
   * dispatched from a detached element reaches nobody. So the release is done
   * here, where the element that is going away cannot be the one responsible
   * for the last word about it.
   */
  private _handleWindowClose(event: CustomEvent) {
    if (event.detail?.id !== "automaticCaption") {
      return;
    }
    this.timelineState.setCursorType("pointer");
  }

  render() {
    return html`
      <div
        id="split_col_1"
        class="bg-darker h-100 overflow-y-hidden overflow-x-hidden position-relative p-0"
        style="width: ${this.resize.horizontal.panel}%;"
      >
        <div
          class="split-col-bar"
          @mousedown=${this._handleClickResizePanel}
        ></div>

        <div
          class=" h-100 w-100 overflow-y-hidden overflow-x-hidden position-absolute "
        >
          <div class="d-flex align-items-start h-100">
            <div
              id="sidebar"
              class="nav sidebar-nav flex-column nav-pills bg-dark h-100 pt-1"
              style="width: 2.5rem;"
              role="tablist"
              aria-orientation="vertical"
            >
              <button
                class="btn-nav active"
                data-bs-toggle="pill"
                data-bs-target="#nav-home"
                type="button"
                role="tab"
                aria-selected="true"
              >
                <span class="material-symbols-outlined"> settings</span>
              </button>

              <button
                class="btn-nav"
                data-bs-toggle="pill"
                data-bs-target="#nav-draft"
                type="button"
                role="tab"
                aria-selected="false"
              >
                <span class="material-symbols-outlined"> draft</span>
              </button>

              <button
                class="btn-nav"
                data-bs-toggle="pill"
                data-bs-target="#nav-text"
                type="button"
                role="tab"
                aria-selected="false"
              >
                <span class="material-symbols-outlined"> text_fields</span>
              </button>

              <button
                class="btn-nav"
                data-bs-toggle="pill"
                data-bs-target="#nav-util"
                type="button"
                role="tab"
                aria-selected="false"
              >
                <span class="material-symbols-outlined"> page_info</span>
              </button>

              <button
                class="btn-nav"
                data-bs-toggle="pill"
                data-bs-target="#nav-option"
                type="button"
                role="tab"
                aria-selected="false"
              >
                <span class="material-symbols-outlined"> extension</span>
              </button>

              <button
                class="btn-nav"
                data-bs-toggle="pill"
                data-bs-target="#nav-fx"
                type="button"
                role="tab"
                aria-selected="false"
              >
                <span class="material-symbols-outlined"> auto_awesome</span>
              </button>

              <button
                class="btn-nav"
                data-bs-toggle="pill"
                data-bs-target="#nav-template"
                type="button"
                role="tab"
                aria-selected="false"
              >
                <span class="material-symbols-outlined">
                  dashboard_customize</span
                >
              </button>
            </div>
            <div
              class="tab-content overflow-y-scroll overflow-x-hidden  p-2 h-100"
              style="width: calc(100% - 2.5rem);"
            >
              <div
                class="tab-pane fade show active"
                id="nav-home"
                role="tabpanel"
              >
                <control-ui-setting />
              </div>

              <div class="tab-pane fade" id="nav-draft" role="tabpanel">
                <asset-browser></asset-browser>
              </div>

              <div class="tab-pane fade" id="nav-text" role="tabpanel">
                <control-ui-text />
              </div>

              <div class="tab-pane fade" id="nav-option" role="tabpanel">
                <control-ui-extension />
              </div>

              <div class="tab-pane fade" id="nav-util" role="tabpanel">
                <control-ui-util />
              </div>

              <div class="tab-pane fade" id="nav-fx" role="tabpanel">
                <control-ui-fx></control-ui-fx>
              </div>

              <div class="tab-pane fade" id="nav-template" role="tabpanel">
                <control-ui-template></control-ui-template>
              </div>

              <!--
                Orphaned: no sidebar button targets this pane, so control-ui-filter
                and the gif-preset inside it are unreachable in the running app.
                Left as it was rather than quietly adopted — the gif search is a
                separate feature, and effects and transitions now have a tab of
                their own.
              -->
              <div class="tab-pane fade" id="nav-filter" role="tabpanel">
                <control-ui-filter />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- PREVIEW -->
      <div
        id="split_col_2"
        class="h-100 overflow-y-hidden overflow-x-hidden position-relative p-0"
        style="width: ${this.resize.horizontal.preview}%;"
      >
        <div
          class="split-col-bar"
          @mousedown=${this._handleClickResizePreview}
        ></div>

        <!--
          The column is a window host. Everything that used to sit here
          directly is its content, so the preview keeps the whole column until
          something is docked beside it and gives up exactly that much when one
          is. The rects come from features/window/windowLayout.ts.
        -->
        <window-host
          .hostId=${"preview"}
          .panels=${this._windowPanels()}
          @captionEditorClose=${this._handleCaptionEditorClose}
          @windowClose=${this._handleWindowClose}
          .content=${html`
        <preview-top-bar></preview-top-bar>

        <!--
          A flex column rather than a second height subtraction: the bottom bar
          belongs to the preview tab alone, and the six sibling panels below
          keep the height they had. min-height: 0 on the canvas row is what lets
          a flex item shrink past its intrinsic size — without it the video box
          refuses to give the bar its 2rem and the bar is pushed out of the
          column.
        -->
        <div
          style="height: calc(100% - 2rem);"
          class="position-relative d-flex flex-column ${this.nowActivePanel == ""
            ? ""
            : "d-none"}"
        >
          <div id="video" class="video flex-grow-1" style="min-height: 0;">
            <preview-canvas></preview-canvas>
            <element-control></element-control>
            <drag-alignment-guide></drag-alignment-guide>
          </div>
          <preview-bottom-bar></preview-bottom-bar>
        </div>

        <div
          style="height: calc(100% - 2rem);"
          class="position-relative d-flex align-items-center justify-content-center ${this
            .nowActivePanel == "record"
            ? ""
            : "d-none"}"
        >
          <screen-record-panel></screen-record-panel>
        </div>

        <div
          style="height: calc(100% - 2rem);"
          class="position-relative d-flex align-items-center justify-content-center ${this
            .nowActivePanel == "audioRecord"
            ? ""
            : "d-none"}"
        >
          <audio-record-panel></audio-record-panel>
        </div>

        <div
          style="height: calc(100% - 2rem);"
          class="position-relative d-flex align-items-start justify-content-center ${this
            .nowActivePanel == "proxy"
            ? ""
            : "d-none"}"
        >
          <proxy-panel></proxy-panel>
        </div>

        <div
          style="height: calc(100% - 2rem);"
          class="position-relative d-flex justify-content-center ${this
            .nowActivePanel == "autoTrack"
            ? ""
            : "d-none"}"
        >
          <auto-track-panel></auto-track-panel>
        </div>
          `}
        ></window-host>
      </div>

      <!-- OPTION-->
      <div
        id="split_col_3"
        class="bg-darker h-100 overflow-y-scroll overflow-x-hidden position-relative option-window p-2"
        style="width: ${this.resize.horizontal.option}%;"
      >
        <input
          type="hidden"
          id="optionTargetElement"
          value="aaaa-aaaa-aaaa-aaaa"
        />

        <!--
          Says so when there is nothing to show. Every panel hides itself in its
          constructor and nothing shows one until a clip is selected, so the
          column opens empty — and an empty column reads as something that
          failed to load rather than as one waiting for a selection.
        -->
        <div
          class="h-100 d-flex flex-column align-items-center justify-content-center text-center px-3 gap-2 ${this
            .isOptionPanelActive
            ? "d-none"
            : ""}"
        >
          <!--
            The icon-lg class hardcodes a white colour, so the grey is set
            inline rather than with a utility class — a class would be a
            specificity argument this has no reason to be having.

            #5a6473 sits at 3.2:1 against this column's near-black background,
            which clears the 3:1 floor for a graphic this size while staying
            dimmer than the text below it — the icon is the quieter half of an
            empty state, not the louder one.
          -->
          <span
            class="material-symbols-outlined icon-lg"
            style="color: #5a6473;"
          >
            tune
          </span>
          <span class="text-secondary" style="font-size: 13px;">
            ${this.lc.t("setting.no_selection")}
          </span>
        </div>

        <option-group>
          <option-text></option-text>
          <option-image></option-image>
          <option-video></option-video>
          <option-audio></option-audio>
          <option-shape></option-shape>
          <option-groupelement></option-groupelement>
          <option-template></option-template>
          <!--
            Tag names are not free here. optionGroup resolves a panel by
            prefixing "option-" onto the element's own filetype, so these two
            follow from the data model rather than being chosen.
          -->
          <option-effect></option-effect>
          <option-transition></option-transition>
        </option-group>
      </div>
    `;
  }
}

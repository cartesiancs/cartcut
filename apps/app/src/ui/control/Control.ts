import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import "./ControlSetting";
import "./ControlText";
import "./ControlExtension";
import "./ControlRender";
import "./ControlUtilities";
import "./ControlFilter";
import "./ControlFx";
import "../../features/preview/previewTopBar";
import "../../features/preview/previewBottomBar";
import "../../features/record/screenRecord";
import "../../features/record/audioRecord";
import "../../features/ytdown/ytDownload";
import "../../features/track/autoTrackPanel";

import "../../../../automatic-caption/src/automaticCaption";

import { IUIStore, uiStore } from "../../states/uiStore";
import { TimelineController } from "../../controllers/timeline";
import {
  IControlPanelStore,
  controlPanelStore,
} from "../../states/controlPanelStore";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { captionToTimeline } from "../../features/caption/timing";
import { LocaleController } from "../../controllers/locale";

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

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
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
   * Place transcribed captions on the timeline.
   *
   * The transcript timestamps the *source file*, so each caption's start has to
   * be mapped through the clip it came from — trim offset and speed included —
   * before it can be placed. Captions used to carry a `parentKey` and be
   * rendered at `parent.startTime + own.startTime`, which was the same
   * conversion done implicitly, at draw time, forever, and only for a 1x
   * untrimmed clip. Doing it once here leaves every caption an ordinary clip
   * holding an absolute time, so many of them share one text track.
   */
  _handleComplateAutoCaption(e) {
    const result = e.detail.result;
    const control = document.querySelector("element-control");
    const timeline = useTimelineStore.getState().timeline;

    for (let index = 0; index < result.length; index++) {
      const { sourceKey, ...caption } = result[index];
      const source = sourceKey ? timeline[sourceKey] : undefined;

      control.addText({
        ...caption,
        ...captionToTimeline(caption, source),
      });
    }
  }

  _handleChangeCursorType(e) {
    const type = e.detail.type;

    this.timelineState.setCursorType(type);
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
                data-bs-target="#nav-output"
                type="button"
                role="tab"
                aria-selected="false"
              >
                <span class="material-symbols-outlined"> output</span>
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

              <div class="tab-pane fade" id="nav-output" role="tabpanel">
                <control-ui-render />
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
          class="position-relative d-flex align-items-center justify-content-center ${this
            .nowActivePanel == "ytDownload"
            ? ""
            : "d-none"}"
        >
          <youtube-download></youtube-download>
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

        <div
          style="height: calc(100% - 2rem);"
          class="position-relative d-flex align-items-center justify-content-center ${this
            .nowActivePanel == "automaticCaption"
            ? ""
            : "d-none"}"
        >
          <automatic-caption
            .timeline=${this.timeline}
            .isDev=${false}
            @editComplate=${this._handleComplateAutoCaption}
            @changeCursorType=${this._handleChangeCursorType}
          ></automatic-caption>
        </div>
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

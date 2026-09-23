import { LitElement, html } from "lit";
import { repeat } from "lit/directives/repeat.js";
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
import "../../features/tts/ttsPanel";
import "../../features/window/windowHost";
import "../../features/extension/viewPanel";

import "../../../../automatic-caption/src/automaticCaption";

import { contributionStore } from "../../features/extension/contributions";
import { extensionSidebarTabs, extensionWindowPanels } from "../../features/extension/views";
import { IUIStore, uiStore } from "../../states/uiStore";
import { TimelineController } from "../../controllers/timeline";
import {
  IControlPanelStore,
  controlPanelStore,
} from "../../states/controlPanelStore";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { timelineLockStore } from "../../states/timelineLockStore";
import { selectionStore } from "../../states/selectionStore";
import {
  CaptionSession,
  type CaptionSessionPhase,
} from "../../features/caption/captionSession";
import { windowScheduler } from "../../features/caption/previewLoop";
import type { CaptionPlayheadPort } from "../../features/caption/playheadPort";
import { clipsAcrossCuts } from "../../features/timeline/rippleMap";
import { snapMsToFrame } from "../../features/timeline/frames";
import { ensureUndoBaseline } from "../../features/agent/checkpoint";
import { v4 as uuidv4 } from "uuid";
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
   * `renderOptionStore` would make it depend on zustand. `captionStyle` lays a
   * caption out as fractions of this frame, so it is what decides where the
   * words sit and how big they are.
   *
   * The panel used to want it for a second reason, to size its own preview
   * canvas. It has no canvas now: the captions are on the real timeline while
   * the panel is open, so the app's own preview is the preview. `backgroundColor`
   * went with that canvas and is no longer passed down at all.
   */
  @property()
  previewSize = renderOptionStore.getInitialState().options.previewSize;

  createRenderRoot() {
    // Extensions connect after the first paint, and reconnect whenever the
    // host restarts. Without this the tabs an extension contributes appear
    // only after some unrelated edit happens to trigger a repaint, which is
    // the same defect `subscribePresets` exists to fix for effect names.
    contributionStore.subscribe(() => this.requestUpdate());

    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
    });

    renderOptionStore.subscribe((state) => {
      this.previewSize = state.options.previewSize;
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
   * The session that owns the timeline while the caption panel is open.
   *
   * Held here rather than made per transcript, because `Control` is what
   * outlives the panel: the window unmounts `<automatic-caption>` when it is
   * closed, and an event dispatched from a detached element reaches nobody.
   * That is the same reason `_handleWindowClose` exists a few lines down, and
   * cancelling the session is the second thing it now has to do.
   *
   * The ports are the store, the lock and a frame clock. None of them is
   * imported inside `captionSession.ts`, which is what lets its whole state
   * machine run under `environment: "node"` against fakes.
   */
  private captionSession = new CaptionSession({
    document: {
      read: () => useTimelineStore.getState().getDocument(),
      // No normalisation and no history: the session writes on every frame of
      // its reveal and on every keystroke, and `previewDocument` is the channel
      // the drag preview already uses for exactly that reason.
      preview: (doc) => useTimelineStore.getState().previewDocument(doc),
      // What is on screen, not a recomputation of it. `GestureCommit.flush`
      // makes the same call: a second computation is a second chance to
      // disagree with the picture the user just approved.
      commitShown: () => {
        const shown = useTimelineStore.getState().getDocument();
        useTimelineStore.getState().withCheckpoint(() => shown);
      },
      ensureBaseline: () => ensureUndoBaseline(),
    },
    lock: {
      lock: () => timelineLockStore.getState().lock("captionSession"),
      unlock: () => timelineLockStore.getState().unlock(),
    },
    scheduler: windowScheduler(),
    now: () => performance.now(),
    mintId: uuidv4,
    // The same grid the mouse is held to. Passed in rather than imported there,
    // so `captionSession.ts` reads no store and stays node-testable.
    snap: (ms) =>
      snapMsToFrame(ms, renderOptionStore.getState().options.fps),
    onPhase: (phase) => {
      this.captionSessionPhase = phase;
    },
  });

  /**
   * What the session is doing, for the panel's own progress screen.
   *
   * Written twice per session rather than per frame, which is why it can be a
   * plain property: the panel needs to know when the reveal has finished so it
   * can swap its "Applying to the timeline" screen for the caption list, and
   * only the session knows when that is.
   */
  @property()
  captionSessionPhase: CaptionSessionPhase = "idle";

  /**
   * The panel has words and silences. Take the timeline.
   *
   * What is left here is the one thing only this component can do: read the
   * store. The chosen clips are resolved, the session is handed them, and
   * everything after that is the session's, including the planning, because by
   * the second change `doc.elements[key]` names a *piece* of a clip or nothing
   * at all.
   *
   * The warnings moved forward with the cuts. They used to fire on Apply,
   * which was the moment the cuts happened; the cuts happen as soon as a
   * transcript lands now, so this is that moment.
   */
  /**
   * An arrow property, and all four of these have to be.
   *
   * The panel's template is built here and rendered by `<app-window>`, and Lit
   * binds an event listener's `this` to the **host of the render**, which is
   * that component and not this one. A plain method therefore runs with `this`
   * as the window: `this.captionSession` is undefined and the listener throws
   * inside Lit, where nothing surfaces it.
   *
   * It was already wrong before this feature and mostly got away with it: the
   * old `editComplate` handler read only module-level stores on its common
   * path. The single line that did use `this`, the toast for cuts covering the
   * whole clip, was the one branch nobody hit. `changeCursorType` was not so
   * lucky, and the panel's keyboard lock has been silently dead since the
   * editor became a window.
   */
  _handleCaptionSessionStart = (e) => {
    const doc = useTimelineStore.getState().getDocument();
    // Read before anything cuts them. `removeRanges` splits a clip and the
    // original id does not always survive, so this is the only moment the
    // chosen clips can be resolved at all. The session holds them from here.
    const clips = (e.detail.clips ?? []).map((clip) => ({
      key: clip.key,
      source: doc.elements[clip.key],
      sourceRanges: clip.sourceRanges ?? [],
    }));

    this.captionSession.start({
      lines: e.detail.lines ?? [],
      clips,
      frame: this.previewSize,
      placement: e.detail.placement ?? "lowerThird",
    });

    // The warnings read back what the session decided, because the planning
    // and the clamping are its job now. They fire here and not on every later
    // change: each describes something settled once, not a state the user is
    // going to keep looking at.
    const covered = this.captionSession.coveredClips.length;
    if (covered > 0) {
      this.toastCaption(
        covered === 1 && clips.length === 1
          ? "Those silences cover the whole clip, so nothing was cut. The captions were placed."
          : `The silences cover ${covered} whole clip(s), so those were not cut. Their captions were placed.`,
      );
    }

    const refused = this.captionSession.refusedClips.length;
    if (refused > 0) {
      this.toastCaption(
        `${refused} clip(s) overlap another chosen clip or sit on no video or audio track, so they were not cut. Their captions were placed.`,
      );
    }

    // The ripple is lane-local, so anything on another row keeps its old timing
    // and drifts out of sync with the speech. That includes a chosen clip on
    // another row, which drifts against the clips it was playing with. Said
    // plainly rather than discovered at playback.
    const stranded = new Set<string>();
    for (const [trackId, cuts] of this.captionSession.cutsByTrack) {
      for (const id of clipsAcrossCuts(doc, trackId, cuts)) {
        stranded.add(id);
      }
    }
    if (stranded.size > 0) {
      this.toastCaption(
        `${stranded.size} clip(s) on other tracks overlap the cuts and were not moved, so they may now be out of sync.`,
      );
    }
  };

  private toastCaption(message: string) {
    (document.querySelector("toast-box") as any)?.showToast({
      message,
      delay: "6000",
    });
  }

  /** A text edit, a split, a merge, a strike-out, a realignment, a toggle. */
  _handleCaptionSessionChange = (e) => {
    this.captionSession.update({
      lines: e.detail.lines ?? [],
      placement: e.detail.placement ?? "lowerThird",
      ranges: e.detail.ranges ?? [],
    });
  };

  /** Apply. One undo step, holding exactly what the user is looking at. */
  _handleCaptionSessionApply = () => {
    this.captionSession.apply();
  };

  /**
   * The panel's view of the playhead, as one stable object.
   *
   * Built once and handed down, so subscribing costs the panel one listener and
   * costs this component nothing. Writing the cursor into a `@property` instead
   * would re-render the whole preview column sixty times a second.
   */
  private captionPlayhead: CaptionPlayheadPort = {
    subscribe: (onChange) =>
      useTimelineStore.subscribe((state, previous) => {
        if (state.cursor !== previous.cursor) {
          onChange();
        }
      }),
    sourcePositions: () =>
      this.captionSession.sourcePositionsOf(useTimelineStore.getState().cursor),
    seekToSource: (key, seconds) => {
      const at = this.captionSession.timelineMsOf(key, seconds * 1000);
      if (at != null) {
        useTimelineStore.getState().setCursor(at);
      }
    },
  };

  /**
   * The timeline's selection, read when the clip picker opens.
   *
   * A function rather than a property, so a selection change does not
   * re-render this component, which holds the whole preview column.
   */
  private readonly captionTimelineSelection = (): string[] =>
    selectionStore.getState().ids;

  _handleChangeCursorType = (e) => {
    // See `_handleCaptionSessionStart` on why this is an arrow property. As a
    // method it ran with `this` bound to `<app-window>`, so `this.timelineState`
    // was undefined and the panel's keyboard lock threw instead of applying.
    useTimelineStore.getState().setCursorType(e.detail.type);
  };

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
        id: "textToSpeech",
        label: this.lc.t("window.text_to_speech") || "Text to Speech",
        content: html`<tts-panel></tts-panel>`,
      },
      {
        id: "automaticCaption",
        label: this.lc.t("window.automatic_caption") || "Automatic Caption",
        content: html`<automatic-caption
          .timeline=${this.timeline}
          .previewSize=${this.previewSize}
          .playhead=${this.captionPlayhead}
          .timelineSelection=${this.captionTimelineSelection}
          .sessionPhase=${this.captionSessionPhase}
          .isDev=${false}
          @captionSessionStart=${this._handleCaptionSessionStart}
          @captionSessionChange=${this._handleCaptionSessionChange}
          @captionSessionApply=${this._handleCaptionSessionApply}
          @changeCursorType=${this._handleChangeCursorType}
        ></automatic-caption>`,
      },
      // Whatever the loaded extensions contribute. Listed here rather than
      // opened here: a panel that is listed but not open in `windowStore`
      // draws nothing, so `window.showPanel` stays a store write.
      ...extensionWindowPanels(),
    ];
  }

  /**
   * Finishing an edit puts the window away.
   *
   * Apply and the tab's close both reach `closeEditor`, so both end with the
   * caption tab gone, and the preview holding the whole column again unless
   * another tab is still open. Leaving the tab open on the "Load video" screen
   * after an Apply would read as the edit not having been taken.
   */
  private _handleCaptionEditorClose() {
    windowStore.getState().close("automaticCaption");
  }

  /**
   * Give the keyboard back when the caption tab is closed from its close glyph.
   *
   * The panel scopes its own `lockKeyboard` to focus and releases it on
   * `focusout`, but closing the tab unmounts the panel, and an event
   * dispatched from a detached element reaches nobody. So the release is done
   * here, where the element that is going away cannot be the one responsible
   * for the last word about it.
   */
  private _handleWindowClose(event: CustomEvent) {
    if (event.detail?.id !== "automaticCaption") {
      return;
    }
    this.timelineState.setCursorType("pointer");
    // Closing without applying discards, which is the only other way out of a
    // session. It has to be done here for the same reason the keyboard is given
    // back here: closing unmounts the panel, and an event dispatched from a
    // detached element reaches nobody. `cancel` is a no-op when no session is
    // running, so closing the tab on the setup screen costs nothing. Switching
    // to another tab is not a close and keeps the session: the panel is only
    // hidden.
    this.captionSession.cancel();
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

              ${repeat(
                extensionSidebarTabs(),
                (tab) => tab.key,
                (tab) => html`<button
                  class="btn-nav"
                  data-bs-toggle="pill"
                  data-bs-target="#${tab.paneId}"
                  type="button"
                  role="tab"
                  aria-selected="false"
                  title=${tab.title}
                >
                  <span class="material-symbols-outlined"> ${tab.icon}</span>
                </button>`,
              )}
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

              ${repeat(
                extensionSidebarTabs(),
                (tab) => tab.key,
                (tab) => html`<div
                  class="tab-pane fade h-100"
                  id=${tab.paneId}
                  role="tabpanel"
                >
                  ${tab.content}
                </div>`,
              )}
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

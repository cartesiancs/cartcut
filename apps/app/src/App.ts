import "./features/extension/statusBar";
import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { IUIStore, uiStore } from "./states/uiStore";
import { playbackPreviewStore } from "./states/playbackPreviewStore";
import { loadPresets } from "./features/fx/presetRegistry";
import "./features/demo/warningDemoEnv";
import "./features/gpt/chatSidebar";
import { installLutResolver } from "./features/lut/lutRegistry";
import { installTemplateResolver } from "./features/renderer/template";
import { installPreviewGraphicRuntime } from "./features/graphic/graphicRuntime";
import { IS_MAC } from "./utils/platform";
import { exportElementRenderers } from "./features/export/renderers";
import { templateFor, refreshTemplateLibrary } from "./features/template/templateRegistry";
import { MOBILE_LAYOUT } from "./features/mobile/install";
import "./features/mobile/mobileShell";

@customElement("app-root")
export class App extends LitElement {
  @property()
  uiState: IUIStore = uiStore.getInitialState();

  @property()
  resize = this.uiState.resize;

  @property()
  topBarTitle = this.uiState.topBarTitle;

  createRenderRoot() {
    uiStore.subscribe((state) => {
      this.resize = state.resize;
      this.topBarTitle = state.topBarTitle;
    });

    // The playback preview's input block, as one class on the real document
    // body. A class rather than a re-render because the rule has to cover
    // `chat-sidebar` and every column at once, and because a Lit update of this
    // component rebuilds the whole editor tree — including the preview canvas —
    // which is a heavy price for a mode toggle.
    //
    // `document.body` is the outer one. The `<body>` this component renders
    // inside its own template is an ordinary element Lit created, not the
    // document's.
    playbackPreviewStore.subscribe((state) => {
      document.body.classList.toggle("playback-preview", state.state.active);
    });

    // Point the renderer's LUT lookup at the registry. Before `loadPresets`
    // rather than after: it only installs a function, and doing it first means
    // there is no window in which a repaint could ask for a grade and find no
    // resolver at all.
    installLutResolver();

    // Effect, transition and LUT presets, read once at startup — the same shape
    // as the font preset list. Un-awaited on purpose: nothing on screen depends
    // on it, a project that references a preset renders as a pass-through until
    // it arrives, and the first repaint after it lands picks it up.
    // `loadPresets` never throws, so there is nothing here to catch.
    void loadPresets();

    // The same pair for templates, and in the same order and for the same
    // reason: install the resolver first so no repaint can ask for a template
    // before there is anything to ask.
    //
    // The table it composites a template's document with is the *export*
    // table, whose only difference from the preview's is that its video
    // renderer awaits `seeked` before drawing. Awaiting is the safe half of
    // that choice — the preview repaints continuously, so a frame drawn a
    // moment late is a frame nobody saw — and it is what stops a template's
    // clips showing whatever their decoders happened to be holding.
    installTemplateResolver(templateFor, exportElementRenderers);

    // And the graphic renderer's: the preview's generator, the registry, the
    // latest HTML rasters. An export opens a scope of its own instead.
    installPreviewGraphicRuntime();

    // Un-awaited, exactly as `loadPresets` is: a template that has not been
    // enumerated yet draws nothing, which is the contract, and the first
    // repaint after the list lands picks it up.
    void refreshTemplateLibrary();

    return this;
  }

  _handleClick() {
    this.uiState.updateVertical(this.resize.vertical.bottom + 2);
  }

  /**
   * The editor on a phone: the same `control-ui` and `timeline-ui`, stacked in
   * one column between the phone chrome, with `_mobile.scss` turning the two
   * side columns into sheets. The chat sidebar is left out; it needs the
   * Electron bridge, which no phone has.
   */
  private mobileEditor() {
    return html`
      <div class="m-app">
        <mobile-top-bar></mobile-top-bar>
        <control-ui id="split_top" class="m-preview"></control-ui>
        <mobile-transport></mobile-transport>
        <timeline-ui
          id="split_bottom"
          class="m-timeline position-relative bg-darker"
        ></timeline-ui>
        <mobile-toolbar></mobile-toolbar>
      </div>
    `;
  }

  private desktopTopBar() {
    return html`
      <div class="top-bar ${IS_MAC ? "top-bar-mac" : "top-bar-pc"}">
        <b>${this.topBarTitle}</b>
        <export-button></export-button>
      </div>
    `;
  }

  private desktopColumns() {
    return html`
        <div class="d-flex col justify-content-start">
          <div
            style="height: 97vh;padding-left: var(--bs-gutter-x,.75rem);width: calc(100% - ${this
              .resize.chatSidebar}px);"
          >
            <control-ui
              id="split_top"
              class="row align-items-start"
              style="height: ${this.resize.vertical.top}%;"
            ></control-ui>
            <timeline-ui
              id="split_bottom"
              class="row position-relative split-top align-items-end bg-darker line-top"
              style="height: ${this.resize.vertical.bottom}%;"
            ></timeline-ui>
          </div>

          <chat-sidebar width="${this.resize.chatSidebar}px"></chat-sidebar>
        </div>
    `;
  }

  render() {
    return html`
      <asset-upload-drop></asset-upload-drop>

      ${MOBILE_LAYOUT ? "" : this.desktopTopBar()}

      <body class="h-100 bg-dark">
        <div id="app"></div>

        ${MOBILE_LAYOUT ? this.mobileEditor() : this.desktopColumns()}

        <offcanvas-list-ui></offcanvas-list-ui>
        <modal-list-ui></modal-list-ui>

        <div id="menuRightClick"></div>
        <timeline-note-card></timeline-note-card>
        <style id="fontStyles" ref="fontStyles"></style>

        <toast-box></toast-box>
        <subtitle-import-dialog></subtitle-import-dialog>
        <media-info-dialog></media-info-dialog>
        <!-- Over the other dialogs and under the toasts: a toast about the take has
             to stay readable while this is up. -->
        <recording-process-dialog></recording-process-dialog>
        <!-- Long-running work — reversing a clip — in the bottom-left, clear
             of the toasts at bottom-centre. -->
        <background-tasks></background-tasks>
        <!-- Whatever extensions have put there, in the bottom-right: the other
             three corners belong to the task tray, the toasts and the export
             button. -->
        <ext-status-items></ext-status-items>

        <warning-demo></warning-demo>
        <onboarding-overlay></onboarding-overlay>
        <!-- Starts when the tour above finishes, for first-run users only. -->
        <tutorial-coachmark></tutorial-coachmark>
        <update-prompt></update-prompt>
      </body>
    `;
  }
}

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { IUIStore, uiStore } from "./states/uiStore";
import { playbackPreviewStore } from "./states/playbackPreviewStore";
import { loadPresets } from "./features/fx/presetRegistry";
import "./features/demo/warningDemoEnv";
import "./features/gpt/chatSidebar";
import { installLutResolver } from "./features/lut/lutRegistry";
import { installTemplateResolver } from "./features/renderer/template";
import { exportElementRenderers } from "./features/export/renderers";
import { templateFor, refreshTemplateLibrary } from "./features/template/templateRegistry";

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

    // Un-awaited, exactly as `loadPresets` is: a template that has not been
    // enumerated yet draws nothing, which is the contract, and the first
    // repaint after the list lands picks it up.
    void refreshTemplateLibrary();

    return this;
  }

  _handleClick() {
    this.uiState.updateVertical(this.resize.vertical.bottom + 2);
  }

  render() {
    return html`
      <asset-upload-drop></asset-upload-drop>

      <div class="top-bar">
        <b>${this.topBarTitle}</b>
      </div>

      <body class="h-100 bg-dark">
        <div id="app"></div>

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

        <offcanvas-list-ui></offcanvas-list-ui>
        <modal-list-ui></modal-list-ui>

        <div id="menuRightClick"></div>
        <style id="fontStyles" ref="fontStyles"></style>

        <toast-box></toast-box>

        <warning-demo></warning-demo>
        <onboarding-overlay></onboarding-overlay>
      </body>
    `;
  }
}

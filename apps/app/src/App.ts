import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { IUIStore, uiStore } from "./states/uiStore";
import { loadPresets } from "./features/fx/presetRegistry";
import "./features/demo/warningDemoEnv";
import "./features/gpt/chatSidebar";
import { installLutResolver } from "./features/lut/lutRegistry";

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
        <toast-list-ui></toast-list-ui>

        <div id="menuRightClick"></div>
        <style id="fontStyles" ref="fontStyles"></style>

        <toast-box></toast-box>

        <warning-demo></warning-demo>
        <onboarding-overlay></onboarding-overlay>
      </body>
    `;
  }
}

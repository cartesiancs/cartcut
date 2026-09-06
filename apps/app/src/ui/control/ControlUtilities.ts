import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LocaleController } from "../../controllers/locale";
import {
  controlPanelStore,
  IControlPanelStore,
} from "../../states/controlPanelStore";

@customElement("control-ui-util")
export class ControlText extends LitElement {
  private lc = new LocaleController(this);

  @property()
  controlPanel: IControlPanelStore = controlPanelStore.getInitialState();

  createRenderRoot() {
    return this;
  }

  /**
   * Opening is idempotent: the store dedupes on the panel name and focuses the
   * tab, so hammering a utility button shows the panel rather than stacking a
   * new tab per click.
   */
  _handleClickPanel(name) {
    this.controlPanel.openPanel(name);
  }

  _handleClickOverlayRecord() {
    window.electronAPI.req.overlayRecord.show();
  }

  render() {
    return html`
      <p class="text-secondary">Utilities</p>
      <div class="row px-2">
        <div
          class="col-4 d-flex flex-column bd-highlight overflow-hidden mt-1 asset"
          @click=${() => this._handleClickPanel("record")}
        >
          <span class="material-symbols-outlined icon-lg align-self-center">
            radio_button_checked
          </span>
          <b class="align-self-center text-light text-center">Record</b>
        </div>

        <div
          class="col-4 d-flex flex-column bd-highlight overflow-hidden mt-1 asset"
          @click=${() => this._handleClickPanel("audioRecord")}
        >
          <span class="material-symbols-outlined icon-lg align-self-center">
            mic
          </span>
          <b class="align-self-center text-light text-center">Audio Record</b>
        </div>

        <div
          class="col-4 d-flex flex-column bd-highlight overflow-hidden mt-1 asset"
          @click=${() => this._handleClickPanel("automaticCaption")}
        >
          <span class="material-symbols-outlined icon-lg align-self-center">
            subtitles
          </span>
          <b class="align-self-center text-light text-center"
            >Automatic Caption</b
          >
        </div>

        <div
          class="col-4 d-flex flex-column bd-highlight overflow-hidden mt-1 asset"
          @click=${() => this._handleClickOverlayRecord()}
        >
          <span class="material-symbols-outlined icon-lg align-self-center">
            screen_record
          </span>
          <b class="align-self-center text-light text-center"
            >Screen Recorder</b
          >
        </div>

        <div
          class="col-4 d-flex flex-column bd-highlight overflow-hidden mt-1 asset"
          @click=${() => this._handleClickPanel("proxy")}
        >
          <span class="material-symbols-outlined icon-lg align-self-center">
            speed
          </span>
          <b class="align-self-center text-light text-center">Proxy Media</b>
        </div>

        <div
          class="col-4 d-flex flex-column bd-highlight overflow-hidden mt-1 asset"
          @click=${() => this._handleClickPanel("ytDownload")}
        >
          <span class="material-symbols-outlined icon-lg align-self-center">
            youtube_activity
          </span>
          <b class="align-self-center text-light text-center"
            >Youtube Download</b
          >
        </div>
      </div>
    `;
  }
}

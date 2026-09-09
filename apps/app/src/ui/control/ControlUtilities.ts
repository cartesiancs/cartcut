import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LocaleController } from "../../controllers/locale";
import {
  controlPanelStore,
  IControlPanelStore,
} from "../../states/controlPanelStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { serializeRenderOptions } from "../../features/project/renderOptionsFile";
import { exportTemplate } from "../../features/template/templateExport";
import { renderTemplateThumbnail } from "../../features/template/templateThumbnail";

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

  private toast(message: string) {
    (document.querySelector("toast-box") as any)?.showToast({
      message,
      delay: "4000",
    });
  }

  /**
   * Package the current project as a `.cttpl`.
   *
   * Everything decidable is in `features/template/exportPlan.ts`; this reads
   * the two stores and reports the result. The warnings it may come back with
   * are shown rather than swallowed: an author whose template contains an
   * effect needs to know it will not render inside one, and after the file is
   * written is too late to be told nothing at all.
   */
  private async _handleClickExportTemplate() {
    const document_ = useTimelineStore.getState().getDocument();
    const options = renderOptionStore.getState().options;

    // No name prompt: `window.prompt` throws in Electron ("prompt() is and
    // will not be supported"), and the save dialog `exportTemplate` opens
    // already asks for a name. The file's name is the template's name.
    //
    // Best effort on the thumbnail. A template without one gets an icon on its
    // tile, which is much better than an export refused because a canvas would
    // not allocate — so `renderTemplateThumbnail` answers null, never throws.
    const thumbnail = await renderTemplateThumbnail(
      useTimelineStore.getState().cursor,
    );

    const result = await exportTemplate({
      elements: document_.elements,
      tracks: document_.tracks,
      renderOptions: serializeRenderOptions(options, {
        previewRatio: 1,
        videoDestination: "",
      }),
      thumbnail,
    });

    if (result.ok) {
      this.toast(
        result.warnings.length > 0
          ? `${result.name} — ${result.warnings.join(" ")}`
          : result.name,
      );
      return;
    }
    // A cancelled dialog is not a failure and must not be reported as one.
    if ("cancelled" in result) {
      return;
    }
    this.toast(result.message);
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
          aria-event="export-template"
          @click=${() => this._handleClickExportTemplate()}
        >
          <span class="material-symbols-outlined icon-lg align-self-center">
            dashboard_customize
          </span>
          <b class="align-self-center text-light text-center"
            >Export Template</b
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
          @click=${() => this._handleClickPanel("autoTrack")}
        >
          <span class="material-symbols-outlined icon-lg align-self-center">
            gps_fixed
          </span>
          <b class="align-self-center text-light text-center">Auto Track</b>
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

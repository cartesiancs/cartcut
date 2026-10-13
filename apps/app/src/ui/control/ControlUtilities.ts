import { LitElement, html } from "lit";
import { windowStore } from "../../features/window/windowStore";
import { DEFAULT_DOCK_PCT } from "../../features/window/windowOps";
import { customElement, property, state } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
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

type UtilityTile = {
  label: string;
  icon: string;
  keywords: string;
  /** The `aria-event` hook a test or the tutorial finds the tile by. */
  event?: string;
  open: () => void;
};

@customElement("control-ui-util")
export class ControlText extends LitElement {
  private lc = new LocaleController(this);

  @property()
  controlPanel: IControlPanelStore = controlPanelStore.getInitialState();

  @state() private query = "";

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

  /**
   * Open the caption editor as a window docked beside the preview.
   *
   * The other four tiles still call `openPanel`, which swaps the whole preview
   * area for a tab. This one does not, because captioning is work you do while
   * watching the footage, and the panel it replaces covered it.
   *
   * `windowStore.open` focuses an existing window rather than opening a second,
   * so pressing the tile twice does what pressing a tab twice does.
   */
  _handleClickCaptionWindow() {
    windowStore.getState().open({
      id: "automaticCaption",
      hostId: "preview",
      placement: { mode: "docked", side: "right", sizePct: DEFAULT_DOCK_PCT },
      // Under this the caption row's two icon buttons and its text input stop
      // fitting on one line. `caption/editorLayout.ts` states the derivation.
      minSize: { width: 320, height: 240 },
    });
  }

  _handleClickOverlayRecord() {
    window.electronAPI.req.overlayRecord.show();
  }

  /**
   * Open Text to Speech as a window docked beside the preview.
   *
   * A window rather than a tab, for the reason captioning is one: narration is
   * written while watching the footage, and a panel that replaced the preview
   * would cover the thing being narrated.
   */
  _handleClickTextToSpeech() {
    windowStore.getState().open({
      id: "textToSpeech",
      hostId: "preview",
      placement: { mode: "docked", side: "right", sizePct: DEFAULT_DOCK_PCT },
      // Under this the voice and language selects stop sharing a line.
      minSize: { width: 320, height: 280 },
    });
  }

  /**
   * Open the Prompter as a window docked beside the preview.
   *
   * A window for the reason captioning and Text to Speech are one: a script is
   * read while recording, and a panel that replaced the preview would hide the
   * take.
   */
  _handleClickPrompter() {
    windowStore.getState().open({
      id: "prompter",
      hostId: "preview",
      placement: { mode: "docked", side: "right", sizePct: DEFAULT_DOCK_PCT },
      // The type bottoms out at 1.75rem, so at 280px a line holds eight Korean
      // syllables between its 1.75rem margins. Narrower reads a word at a time.
      minSize: { width: 280, height: 240 },
    });
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
   * the two stores and reports the result. Any warning it comes back with is
   * shown rather than swallowed: after the file is written is too late to be
   * told nothing at all.
   *
   * In a template's own tab the stores hold that template, so this packages
   * it: the timeline showing is the one exported.
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

  /**
   * Every tile, in panel order. `keywords` are what someone might type who
   * knows the job but not our name for it: "subtitle" finds Automatic Caption.
   */
  private tiles(): UtilityTile[] {
    return [
      {
        label: "Record",
        icon: "radio_button_checked",
        keywords: "camera webcam video",
        open: () => this._handleClickPanel("record"),
      },
      {
        label: "Audio Record",
        icon: "mic",
        keywords: "microphone voice sound",
        open: () => this._handleClickPanel("audioRecord"),
      },
      {
        label: "Automatic Caption",
        icon: "subtitles",
        keywords: "subtitle transcript speech",
        open: () => this._handleClickCaptionWindow(),
      },
      {
        label: "Screen Recorder",
        icon: "screen_record",
        keywords: "screen capture record",
        open: () => this._handleClickOverlayRecord(),
      },
      {
        label: "Export Template",
        icon: "dashboard_customize",
        keywords: "template cttpl",
        event: "export-template",
        open: () => this._handleClickExportTemplate(),
      },
      {
        label: "Text to Speech",
        icon: "record_voice_over",
        keywords: "tts voice narration",
        event: "text-to-speech",
        open: () => this._handleClickTextToSpeech(),
      },
      {
        label: "Prompter",
        icon: "speaker_notes",
        keywords: "teleprompter script",
        event: "prompter",
        open: () => this._handleClickPrompter(),
      },
      {
        label: "Proxy Media",
        icon: "speed",
        keywords: "proxy performance",
        open: () => this._handleClickPanel("proxy"),
      },
      {
        label: "Auto Track",
        icon: "gps_fixed",
        keywords: "motion tracking null",
        open: () => this._handleClickPanel("autoTrack"),
      },
    ];
  }

  private _handleInputQuery(event: Event) {
    this.query = (event.target as HTMLInputElement).value;
  }

  render() {
    const needle = this.query.trim().toLowerCase();
    const visible = this.tiles().filter((tile) =>
      `${tile.label} ${tile.keywords}`.toLowerCase().includes(needle),
    );

    return html`
      <div class="browse-bar">
        <label class="browse-field">
          <span class="material-symbols-outlined browse-field-icon"
            >search</span
          >
          <input
            type="search"
            class="browse-input"
            spellcheck="false"
            placeholder="Search utilities"
            .value=${this.query}
            @input=${this._handleInputQuery}
          />
        </label>
      </div>

      ${visible.length === 0
        ? html`<div class="browse-empty">
            <div class="browse-empty-icon">
              <span class="material-symbols-outlined">search_off</span>
            </div>
            <div class="browse-empty-title">No matches</div>
            <div class="browse-empty-text">Try another name.</div>
          </div>`
        : html`<div class="row px-2">
            ${visible.map(
              (tile) => html`<div
                class="col-4 d-flex flex-column bd-highlight overflow-hidden mt-1 asset"
                aria-event=${ifDefined(tile.event)}
                @click=${tile.open}
              >
                <span
                  class="material-symbols-outlined icon-lg align-self-center"
                >
                  ${tile.icon}
                </span>
                <b class="align-self-center text-light text-center"
                  >${tile.label}</b
                >
              </div>`,
            )}
          </div>`}
    `;
  }
}

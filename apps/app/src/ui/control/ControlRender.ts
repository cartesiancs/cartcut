import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { LocaleController } from "../../controllers/locale";
import {
  renderOptionStore,
  type IRenderOptionStore,
} from "../../states/renderOptionStore";
import {
  AUDIO_BITRATES,
  AUDIO_CODEC_LABELS,
  AUDIO_SAMPLE_RATES,
  CODEC_CONTAINERS,
  CODEC_SUPPORTS_CRF,
  CODEC_SUPPORTS_HW_ACCEL,
  CODEC_SUPPORTS_SPEED_PRESET,
  CONTAINERS,
  CONTAINER_AUDIO_CODECS,
  CONTAINER_LABELS,
  CONTAINER_VIDEO_CODECS,
  CRF_RANGE,
  ENCODE_PRESETS,
  EXPORT_PRESETS,
  PRESET_NAMES,
  PRORES_PROFILES,
  VIDEO_CODEC_LABELS,
  describeExportSettings,
  detectPreset,
  type Container,
  type ExportSettings,
  type PresetName,
} from "../../features/export/settings";
import { installHttpRenderListeners } from "../../features/export/exportSession";
import { IS_MAC } from "../../utils/platform";

/**
 * The export *settings*, and nothing else.
 *
 * Starting a render lives in `features/export/exportSession.ts` and is reached
 * from the title bar's `<export-button>` and from File → Export. It used to be
 * a method on this component, which meant the export could only be started
 * from a panel that happened to be mounted — and `disconnectedCallback` here
 * stopped the progress ticker, which is actively wrong now that an export
 * outlives whatever started it.
 */
@customElement("control-ui-render")
export class ControlRender extends LitElement {
  private lc = new LocaleController(this);

  @property()
  videoSrc = "";
  httpRenderDoneModal: any;
  hasUpdatedOnce: boolean;

  @property()
  renderOptionStore: IRenderOptionStore = renderOptionStore.getInitialState();

  @property()
  renderOption = this.renderOptionStore.options;

  /**
   * Not a Bootstrap collapse: this template re-renders on every store write, and
   * Bootstrap's `.show` class lives outside Lit's model, so the section would
   * snap shut whenever the user changed a select.
   */
  @state()
  private showAdvanced = false;

  constructor() {
    super();
    this.hasUpdatedOnce = false;
  }

  private get settings(): ExportSettings {
    return this.renderOption.exportSettings;
  }

  private patch(patch: Partial<ExportSettings>) {
    renderOptionStore.getState().updateExportSettings(patch);
  }

  createRenderRoot() {
    renderOptionStore.subscribe((state) => {
      this.renderOption = state.options;
    });

    // The web build's render finishes over socket.io rather than over IPC, and
    // this panel owns the dialog it opens.
    installHttpRenderListeners();
    document.addEventListener("cartcut:http-render-done", (event: any) => {
      this.videoSrc = `/api/file?path=${event.detail.path}`;
      this.httpRenderDoneModal?.show();
    });

    return this;
  }

  updated() {
    if (this.hasUpdatedOnce == false) {
      this.httpRenderDoneModal = new bootstrap.Modal(
        document.getElementById("httpRenderDone"),
        {
          keyboard: false,
        },
      );
    }

    this.hasUpdatedOnce = true;

    this.syncSelects();
  }

  handleClickActionButton() {
    //this.renderControll.requestRender();
  }

  private _handleClickPreset(name: PresetName) {
    this.patch(EXPORT_PRESETS[name]);
  }

  /**
   * The normalizer treats the video codec as authoritative over the container,
   * so a container-only patch would be snapped straight back. The two have to
   * travel together.
   */
  private _handleChangeContainer(e) {
    const container = e.target.value as Container;
    const videoCodec = CODEC_CONTAINERS[this.settings.videoCodec].includes(
      container,
    )
      ? this.settings.videoCodec
      : CONTAINER_VIDEO_CODECS[container][0];

    this.patch({ container, videoCodec });
  }

  /**
   * One `<select>` row, sharing the panel's Bootstrap skin.
   *
   * `key` names the setting this select shows, so `updated()` can reconcile the
   * live selection against the store — see the note there.
   */
  private renderSelect(
    key: keyof ExportSettings,
    label: string,
    options: { value: string | number; label: string }[],
    handler: (e) => void,
  ) {
    const value = this.settings[key];

    return html`
      <label class="form-label text-light">${label}</label>
      <select
        data-setting=${key}
        class="form-select bg-dark text-light form-select-sm mb-3"
        @change=${handler}
      >
        ${options.map(
          (option) => html`
            <option value=${option.value} ?selected=${option.value === value}>
              ${option.label}
            </option>
          `,
        )}
      </select>
    `;
  }

  /**
   * Pushes the store's value onto every select after each render.
   *
   * The `selected` *attribute* only drives an option's initial state: once the
   * user has picked from a select, that option is marked dirty and further
   * attribute changes no longer move the selection. The normalizer does move
   * selections behind the user's back — choosing VP9 forces the container to
   * webm — so without this the dropdown would keep showing a value the store
   * has already overruled.
   */
  private syncSelects() {
    this.querySelectorAll("select[data-setting]").forEach((element: any) => {
      const key = element.dataset.setting as keyof ExportSettings;
      const value = String(this.settings[key]);
      if (element.value !== value) {
        element.value = value;
      }
    });
  }

  /**
   * A checkbox, for the one setting that is a boolean.
   *
   * Deliberately not routed through `syncSelects` the way the dropdowns are —
   * that exists because a `selected` *attribute* stops moving a `<select>` once
   * the user has touched it, and `?checked` has no such problem.
   */
  private renderCheckbox(
    key: keyof ExportSettings,
    label: string,
    checked: boolean,
    handler: (e) => void,
  ) {
    return html`
      <div class="form-check mb-1">
        <input
          class="form-check-input"
          type="checkbox"
          id=${`export-${key}`}
          data-setting=${key}
          ?checked=${checked}
          @change=${handler}
        />
        <label class="form-check-label text-light" for=${`export-${key}`}>
          ${label}
        </label>
      </div>
    `;
  }

  private renderVideoSection() {
    const settings = this.settings;
    const isProRes = settings.videoCodec === "prores";
    const crfRange = CRF_RANGE[settings.videoCodec];
    // VideoToolbox is a macOS facility, and VP9 has no encoder on it. Where
    // neither holds the toggle is not shown at all rather than shown inert.
    const canHardwareAccel = IS_MAC && CODEC_SUPPORTS_HW_ACCEL[settings.videoCodec];
    const hardwareActive = canHardwareAccel && settings.hardwareAccel;

    return html`
      ${this.renderSelect(
        "container",
        this.lc.t("setting.container"),
        CONTAINERS.map((container) => ({
          value: container,
          label: CONTAINER_LABELS[container],
        })),
        (e) => this._handleChangeContainer(e),
      )}
      ${this.renderSelect(
        "videoCodec",
        this.lc.t("setting.video_codec"),
        CONTAINER_VIDEO_CODECS[settings.container].map((codec) => ({
          value: codec,
          label: VIDEO_CODEC_LABELS[codec],
        })),
        (e) => this.patch({ videoCodec: e.target.value }),
      )}
      ${CODEC_SUPPORTS_CRF[settings.videoCodec]
        ? this.renderSelect(
            "qualityMode",
            this.lc.t("setting.quality_mode"),
            [
              { value: "crf", label: this.lc.t("setting.quality_crf") },
              { value: "bitrate", label: this.lc.t("setting.quality_bitrate") },
            ],
            (e) => this.patch({ qualityMode: e.target.value }),
          )
        : ""}
      ${!isProRes && settings.qualityMode === "crf"
        ? html`
            <label class="form-label text-light">
              ${this.lc.t("setting.crf")}
              <span class="text-secondary">${settings.crf}</span>
            </label>
            <input
              type="range"
              class="form-range"
              min=${crfRange.min}
              max=${crfRange.max}
              .value=${String(settings.crf)}
              @input=${(e) => this.patch({ crf: Number(e.target.value) })}
            />
            <p class="text-secondary mb-3" style="font-size: 0.75rem;">
              ${this.lc.t("setting.crf_hint")}
            </p>
          `
        : ""}
      ${!isProRes && settings.qualityMode === "bitrate"
        ? html`
            <label class="form-label text-light"
              >${this.lc.t("setting.bitrate")}</label
            >
            <div class="input-group mb-3">
              <input
                id="videoBitrate"
                type="number"
                class="form-control bg-default text-light"
                min="1"
                .value=${String(settings.videoBitrate)}
                @change=${(e) =>
                  this.patch({ videoBitrate: Number(e.target.value) })}
              />
              <span class="input-group-text bg-default text-light"
                >${this.lc.t("setting.bitrate_unit")}</span
              >
            </div>
          `
        : ""}
      ${canHardwareAccel
        ? html`
            ${this.renderCheckbox(
              "hardwareAccel",
              this.lc.t("setting.hardware_accel"),
              settings.hardwareAccel,
              (e) => this.patch({ hardwareAccel: e.target.checked }),
            )}
            <p class="text-secondary mb-3" style="font-size: 0.75rem;">
              ${this.lc.t(
                isProRes || settings.videoCodec === "h265"
                  ? "setting.hardware_accel_hint"
                  : "setting.hardware_accel_hint_h264",
              )}
            </p>
          `
        : ""}
      ${CODEC_SUPPORTS_SPEED_PRESET[settings.videoCodec] && !hardwareActive
        ? this.renderSelect(
            "preset",
            this.lc.t("setting.encode_preset"),
            ENCODE_PRESETS.map((preset) => ({ value: preset, label: preset })),
            (e) => this.patch({ preset: e.target.value }),
          )
        : ""}
      ${isProRes
        ? html`
            ${this.renderSelect(
              "proresProfile",
              this.lc.t("setting.prores_profile"),
              PRORES_PROFILES.map((profile) => ({
                value: profile.value,
                label: profile.label,
              })),
              (e) => this.patch({ proresProfile: Number(e.target.value) }),
            )}
            <p class="text-secondary mb-3" style="font-size: 0.75rem;">
              ${this.lc.t("setting.prores_hint")}
            </p>
          `
        : ""}
    `;
  }

  private renderAudioSection() {
    const settings = this.settings;

    return html`
      ${this.renderSelect(
        "audioCodec",
        this.lc.t("setting.audio_codec"),
        CONTAINER_AUDIO_CODECS[settings.container].map((codec) => ({
          value: codec,
          label: AUDIO_CODEC_LABELS[codec],
        })),
        (e) => this.patch({ audioCodec: e.target.value }),
      )}
      ${settings.audioCodec !== "pcm_s16le"
        ? this.renderSelect(
            "audioBitrate",
            this.lc.t("setting.audio_bitrate"),
            AUDIO_BITRATES.map((rate) => ({ value: rate, label: `${rate} kbps` })),
            (e) => this.patch({ audioBitrate: Number(e.target.value) }),
          )
        : ""}
      ${this.renderSelect(
        "sampleRate",
        this.lc.t("setting.sample_rate"),
        AUDIO_SAMPLE_RATES[settings.audioCodec].map((rate) => ({
          value: rate,
          label: `${rate} Hz`,
        })),
        (e) => this.patch({ sampleRate: Number(e.target.value) }),
      )}
      ${this.renderSelect(
        "channels",
        this.lc.t("setting.channels"),
        [
          { value: 1, label: this.lc.t("setting.channels_mono") },
          { value: 2, label: this.lc.t("setting.channels_stereo") },
        ],
        (e) => this.patch({ channels: Number(e.target.value) as 1 | 2 }),
      )}
    `;
  }

  render() {
    const activePreset = detectPreset(this.settings);

    return html`
      <label class="form-label text-light"
        >${this.lc.t("setting.export_preset")}</label
      >
      <div class="btn-group w-100 mb-2" role="group">
        ${PRESET_NAMES.map(
          (name) => html`
            <button
              class="btn btn-sm ${activePreset === name
                ? "btn-blue-fill"
                : "btn-default text-light"}"
              @click=${() => this._handleClickPreset(name)}
            >
              ${this.lc.t(`setting.preset_${name}`)}
            </button>
          `,
        )}
        <button
          class="btn btn-sm ${activePreset === "custom"
            ? "btn-blue-fill"
            : "btn-default text-light"}"
          @click=${() => (this.showAdvanced = true)}
        >
          ${this.lc.t("setting.preset_custom")}
        </button>
      </div>

      <p class="text-secondary mb-2" style="font-size: 0.75rem;">
        ${describeExportSettings(this.settings)}
      </p>

      <button
        class="btn btn-sm btn-default text-light w-100 d-flex justify-content-between align-items-center mb-3"
        @click=${() => (this.showAdvanced = !this.showAdvanced)}
      >
        <span>${this.lc.t("setting.advanced_settings")}</span>
        <span class="material-symbols-outlined">
          ${this.showAdvanced ? "expand_less" : "expand_more"}
        </span>
      </button>

      <div class="${this.showAdvanced ? "" : "d-none"}">
        ${this.renderVideoSection()} ${this.renderAudioSection()}
      </div>

      <!--
        No Render button here any more. The trigger is <export-button> in the
        title bar, so it is reachable whatever panel is open and whatever the
        user is doing; this panel is the settings it exports with.
      -->

      <div
        class="modal fade"
        id="httpRenderDone"
        data-bs-keyboard="false"
        tabindex="-1"
      >
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content bg-dark">
            <div class="modal-body">
              <h5 class="modal-title text-white font-weight-lg">Render Done</h5>

              <div class="mt-3">
                <div class="flex row mb-3">
                  <button
                    class="btn btn-sm btn-default text-light mt-1"
                    @click=${() => window.open(this.videoSrc)}
                  >
                    Show File
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

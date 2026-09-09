import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  IRenderOptionStore,
  renderOptionStore,
} from "../../states/renderOptionStore";
import { LocaleController } from "../../controllers/locale";
import "../../components/input/input";
import "../../features/option/optionTabBar";
import type { OptionTabSpec } from "../../features/option/optionTabBar";
import { FPS_PRESETS } from "../../features/timeline/frames";
import { setProjectFps } from "../../features/editor/frameRate";
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
import { IS_MAC } from "../../utils/platform";

/**
 * The two halves of the settings panel.
 *
 * "Canvas" is what the project *is* — the frame everything is composed into,
 * how long it runs and how fast. "Export" is what it becomes on the way out to
 * a file. Stacking them in one scroll was the shape this replaced, and the
 * codec controls pushed the resolution and the frame rate off the top of it.
 */
type SettingTab = "canvas" | "export";

const SETTING_TABS: OptionTabSpec[] = [
  { id: "canvas", label: "Canvas", icon: "aspect_ratio" },
  { id: "export", label: "Export", icon: "output" },
];

/**
 * `#nav-home`: everything that decides what the project *outputs*, plus the
 * app and project chrome that has nowhere better to live.
 *
 * The encoder settings used to be a second sidebar tab of their own,
 * `#nav-output` → `<control-ui-render>`, which meant setting up an export meant
 * visiting two panels that did not know about each other — the resolution in
 * one and the codec that encodes it in the other. They are one panel now, split
 * across a **Canvas** and an **Export** tab by the same `<option-tab-bar>` the
 * clip inspectors use.
 *
 * Starting a render is not here. The trigger is `<export-button>` in the title
 * bar and File → Export, so it is reachable whatever panel is open; this is the
 * settings they export with.
 */
@customElement("control-ui-setting")
export class ControlSetting extends LitElement {
  private lc = new LocaleController(this);

  @property()
  renderOptionStore: IRenderOptionStore = renderOptionStore.getInitialState();

  @property()
  renderOption = this.renderOptionStore.options;

  @property()
  appVersion = "";

  @state()
  private tab: SettingTab = "canvas";

  /**
   * Not a Bootstrap collapse: this template re-renders on every store write, and
   * Bootstrap's `.show` class lives outside Lit's model, so the section would
   * snap shut whenever the user changed a select.
   */
  @state()
  private showAdvanced = false;

  createRenderRoot() {
    renderOptionStore.subscribe((state) => {
      this.renderOption = state.options;
    });

    window.electronAPI.req.app.getAppInfo().then((result) => {
      this.appVersion = `CartCut v${result.data.version}`;
    });

    return this;
  }

  updated() {
    this.syncSelects();
  }

  // ------------------------------------------------------------- the canvas

  _handleUpdateBackgroundColor(e) {
    this.renderOption.backgroundColor = e.target.value;
    this.renderOptionStore.updateOptions(this.renderOption);
  }

  _handleUpdatePreviewSizeW(e) {
    this.renderOption.previewSize.w = Number(e.target.value);
    this.renderOptionStore.updateOptions(this.renderOption);
  }

  _handleUpdatePreviewSizeH(e) {
    this.renderOption.previewSize.h = Number(e.target.value);
    this.renderOptionStore.updateOptions(this.renderOption);
  }

  _handleUpdateDurationSecond(e) {
    const minute = parseInt(
      document.querySelector("#projectDurationMinute").value,
    );
    const second = parseInt(e.target.value);

    this.renderOption.duration = minute * 60 + second;
    this.renderOptionStore.updateOptions(this.renderOption);
  }

  _handleUpdateDurationMinute(e) {
    const minute = parseInt(e.target.value);
    const second = parseInt(
      document.querySelector("#projectDurationSecond").value,
    );

    this.renderOption.duration = minute * 60 + second;
    this.renderOptionStore.updateOptions(this.renderOption);
  }

  /**
   * The project frame rate.
   *
   * Not the mutate-then-`updateOptions` shape the fields above use, because a
   * rate change is not only a store write — the zoom ceiling, the playhead and
   * the baked animation lanes all move with it, and `setProjectFps` is where
   * that sequence lives.
   *
   * The coerced value is written back into the field on purpose. `0`, `500` and
   * `29.97` are all things a number input will hand over, and all three become
   * something else; leaving the box showing the rejected entry would read as
   * "the setting did not take".
   */
  _handleUpdateFps(e) {
    e.target.value = String(setProjectFps(Number(e.target.value)));
  }

  _handleClickChangeLang() {
    if (this.lc.value == "ko") {
      this.lc.changeLanguage("en");
    } else {
      this.lc.changeLanguage("ko");
    }
  }

  _handleClickResolution(w, h) {
    this.renderOption.previewSize.w = w;
    this.renderOption.previewSize.h = h;
    this.renderOptionStore.updateOptions(this.renderOption);
  }

  // ------------------------------------------------------------- the encoder

  private get settings(): ExportSettings {
    return this.renderOption.exportSettings;
  }

  private patch(patch: Partial<ExportSettings>) {
    renderOptionStore.getState().updateExportSettings(patch);
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

  /**
   * Every field below binds with `.value`, not the `value` attribute.
   *
   * For an `<input>` the content attribute is only the *default* value: once
   * the field is dirty the browser stops applying it, exactly as a `<select>`
   * ignores `selected` after the user has picked — which is what `syncSelects`
   * exists to work around. Without it the duration boxes would sit at their
   * hardcoded `0m 10s` after loading a project of any other length, and the
   * resolution presets would move the store without moving the two numbers
   * above them.
   */
  private renderCanvasPane() {
    const duration = this.renderOption.duration;

    return html`
      <label class="form-label text-light"
        >${this.lc.t("setting.video_duration")}</label
      >
      <div class="d-flex flex-row bd-highlight gap-2">
        <div class="input-group mb-3">
          <input
            id="projectDurationMinute"
            type="number"
            class="form-control bg-default text-light"
            placeholder="m"
            @change=${this._handleUpdateDurationMinute}
            .value=${String(Math.floor(duration / 60))}
            min="0"
          />
          <span class="input-group-text bg-default text-light"
            >${this.lc.t("setting.minute_unit")}</span
          >
        </div>

        <div class="input-group mb-3">
          <input
            id="projectDurationSecond"
            type="number"
            class="form-control bg-default text-light"
            placeholder="${this.lc.t("setting.seconds")} e.g) 0"
            @change=${this._handleUpdateDurationSecond}
            .value=${String(duration % 60)}
            min="0"
          />
          <span class="input-group-text bg-default text-light"
            >${this.lc.t("setting.seconds_unit")}</span
          >
        </div>
      </div>

      <label class="form-label text-light">${this.lc.t("setting.frame")}</label>
      <div class="input-group mb-3">
        <input
          id="projectFps"
          type="number"
          class="form-control bg-default text-light"
          list="projectFpsPresets"
          min="1"
          max="240"
          step="1"
          .value=${String(this.renderOption.fps)}
          @change=${this._handleUpdateFps}
        />
        <datalist id="projectFpsPresets">
          ${FPS_PRESETS.map((fps) => html`<option value=${fps}></option>`)}
        </datalist>
        <span class="input-group-text bg-default text-light">fps</span>
      </div>

      <label class="form-label text-light"
        >${this.lc.t("setting.background")}</label
      >
      <div class="input-group mb-3">
        <input
          id="backgroundColor"
          type="color"
          class="form-control bg-default text-light"
          .value=${this.renderOption.backgroundColor}
          @change=${this._handleUpdateBackgroundColor}
          @input=${this._handleUpdateBackgroundColor}
        />
      </div>

      <label class="form-label text-light"
        >${this.lc.t("setting.resolution")}</label
      >
      <div class="d-flex flex-row bd-highlight mb-2">
        <input
          id="previewSizeH"
          type="number"
          class="form-control bg-default text-light me-1"
          .value=${String(this.renderOption.previewSize.h)}
          @change=${this._handleUpdatePreviewSizeH}
        />
        <input
          id="previewSizeW"
          type="number"
          class="form-control bg-default text-light"
          .value=${String(this.renderOption.previewSize.w)}
          @change=${this._handleUpdatePreviewSizeW}
        />
      </div>

      <div class="d-flex flex-column align-items-start mb-3">
        <button
          class="btn btn-sm btn-default text-light mt-1"
          @click=${() => this._handleClickResolution(1920, 1080)}
        >
          1920x1080 (desktop)
        </button>

        <button
          class="btn btn-sm btn-default text-light mt-1"
          @click=${() => this._handleClickResolution(3840, 2160)}
        >
          3840x2160 (4k)
        </button>

        <button
          class="btn btn-sm btn-default text-light mt-1"
          @click=${() => this._handleClickResolution(1080, 1080)}
        >
          1080x1080 (square)
        </button>

        <button
          class="btn btn-sm btn-default text-light mt-1"
          @click=${() => this._handleClickResolution(1080, 1920)}
        >
          1080x1920 (mobile)
        </button>
      </div>
    `;
  }

  private renderVideoSection() {
    const settings = this.settings;
    const isProRes = settings.videoCodec === "prores";
    const crfRange = CRF_RANGE[settings.videoCodec];
    // VideoToolbox is a macOS facility, and VP9 has no encoder on it. Where
    // neither holds the toggle is not shown at all rather than shown inert.
    const canHardwareAccel =
      IS_MAC && CODEC_SUPPORTS_HW_ACCEL[settings.videoCodec];
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
            AUDIO_BITRATES.map((rate) => ({
              value: rate,
              label: `${rate} kbps`,
            })),
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

  /** Preset row, the summary line, and the codec detail behind a disclosure. */
  private renderExportPane() {
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
        No Render button here. The trigger is <export-button> in the title bar
        and File → Export, so it is reachable whatever panel is open; this is
        the settings they export with.
      -->
    `;
  }

  /**
   * `#projectFile` is hidden and is not decoration — `functions/project.ts`
   * remembers the last saved path in it, and ⌘S reads it back to decide between
   * saving and Save As. It is the only thing left at the top of the panel.
   *
   * The "Select Folder" picker that used to sit here is gone. `<asset-browser>`
   * in `#nav-draft` offers the same `selectProjectFolder()` on its own empty
   * state, which is where someone looking for their media already is — two
   * buttons for one action, and this was the one further from the files.
   */
  private renderHeader() {
    return html`
      <input id="projectFile" type="text" class="d-none" name="" />
    `;
  }

  /**
   * The two modal buttons and the version, below both panes.
   *
   * Not in either tab because they belong to neither. Save and Load used to sit
   * here too; they are File → Save Project (⌘S) and Open Project (⌘O), and a
   * second copy of a menu command is the thing that goes stale.
   */
  private renderCommonSection() {
    return html`
      <button
        type="button"
        class="btn btn-sm btn-default text-light mt-1"
        data-bs-toggle="modal"
        data-bs-target="#shortKey"
      >
        <span class="material-symbols-outlined"> keyboard </span>
      </button>

      <button
        type="button"
        class="btn btn-sm btn-default text-light mt-1"
        data-bs-toggle="modal"
        data-bs-target="#changeLang"
      >
        <span class="material-symbols-outlined"> language </span>
      </button>

      <p class="text-secondary mt-3 mb-0" ref="appVersion">
        ${this.appVersion}
      </p>
    `;
  }

  /**
   * Both panes stay mounted and hide with `d-none`, which is the rule
   * `optionTabBar` states and not merely a shortcut. `syncSelects` reconciles
   * every `select[data-setting]` after each render and it walks this panel's
   * own DOM — tearing the Export pane down on a tab switch would leave those
   * selects to be rebuilt from `selected` attributes the browser has already
   * marked dirty.
   */
  render() {
    return html`
      ${this.renderHeader()}

      <option-tab-bar
        .active=${this.tab}
        .tabs=${SETTING_TABS}
        @tab-change=${(e: CustomEvent<SettingTab>) => {
          this.tab = e.detail;
        }}
      ></option-tab-bar>

      <div class=${this.tab === "canvas" ? "" : "d-none"}>
        ${this.renderCanvasPane()}
      </div>

      <div class=${this.tab === "export" ? "" : "d-none"}>
        ${this.renderExportPane()}
      </div>

      <hr class="text-secondary" />

      ${this.renderCommonSection()}
    `;
  }
}

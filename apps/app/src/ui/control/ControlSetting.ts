import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  IRenderOptionStore,
  renderOptionStore,
} from "../../states/renderOptionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { MAIN_TIMELINE } from "../../features/composition/project";
import { LocaleController } from "../../controllers/locale";
import "../../components/input/input";
import "../../features/option/optionTabBar";
import type { OptionTabSpec } from "../../features/option/optionTabBar";
import { fillPercent, section } from "../../features/option/optionKit";
import { FPS_PRESETS } from "../../features/timeline/frames";
import { beginInputScrub } from "../../features/input/inputScrub";
import { SCRUB_FIELDS } from "../../features/input/scrubFields";
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
  GIF_FPS,
  GIF_WIDTHS,
  PRESET_NAMES,
  PRORES_PROFILES,
  VIDEO_CODEC_LABELS,
  describeExportSettings,
  detectPreset,
  gifWidthLabel,
  type Container,
  type ExportSettings,
  type PresetName,
} from "../../features/export/settings";
import { IS_MAC } from "../../utils/platform";
import { getLocationEnv } from "../../functions/getLocationEnv";
import {
  WEB_CONTAINERS,
  WEB_CONTAINER_AUDIO_CODECS,
  WEB_CONTAINER_VIDEO_CODECS,
  webExportSettings,
  type WebContainer,
} from "../../features/export/web/encodeSettings";
import { resetOnboardingAndTutorial } from "../../features/tutorial/tutorialFlag";

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
 * The canvas-size shortcuts, drawn as their own shape.
 *
 * Two of them share 16:9, so the ratio alone does not tell them apart; `tag`
 * is the second line that does, and the full size is in the tooltip.
 */
const RESOLUTION_PRESETS: {
  w: number;
  h: number;
  ratio: string;
  tag: string;
  title: string;
}[] = [
  { w: 1920, h: 1080, ratio: "16:9", tag: "FHD", title: "1920×1080 (desktop)" },
  { w: 3840, h: 2160, ratio: "16:9", tag: "4K", title: "3840×2160 (4K)" },
  {
    w: 1080,
    h: 1080,
    ratio: "1:1",
    tag: "Square",
    title: "1080×1080 (square)",
  },
  {
    w: 1080,
    h: 1920,
    ratio: "9:16",
    tag: "Mobile",
    title: "1080×1920 (mobile)",
  },
];

/** Longest side of a preset's glyph, in px. */
const RATIO_GLYPH_PX = 20;

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

  /**
   * Whether a template's own timeline is the one being edited. The frame size
   * shown is then the template's (`composition/switchEffects.ts`), which is
   * fixed: the clips placing it are drawn from a layer that size, so the
   * resolution fields are disabled until main is showing again.
   */
  @state()
  private editingTemplate =
    useTimelineStore.getState().activeTimelineId !== MAIN_TIMELINE;

  createRenderRoot() {
    renderOptionStore.subscribe((state) => {
      this.renderOption = state.options;
    });

    useTimelineStore.subscribe((state) => {
      const editingTemplate = state.activeTimelineId !== MAIN_TIMELINE;
      if (editingTemplate !== this.editingTemplate) {
        this.editingTemplate = editingTemplate;
      }
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
    if (this.editingTemplate) {
      return;
    }
    this.renderOption.previewSize.w = Number(e.target.value);
    this.renderOptionStore.updateOptions(this.renderOption);
  }

  _handleUpdatePreviewSizeH(e) {
    if (this.editingTemplate) {
      return;
    }
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

  /**
   * Start a drag-scrub on one of the number fields.
   *
   * One handler for all six: the field's `id` names its entry in
   * `SCRUB_FIELDS`, so adding a field is a row in that table rather than a
   * second listener here. A field with no entry simply does not scrub.
   *
   * The scrub commits on release, through the same `@change` handlers a typed
   * edit goes through — see `inputScrub.ts` for why none of them are live.
   */
  _handleScrubDown(e: MouseEvent) {
    const spec = SCRUB_FIELDS[(e.currentTarget as HTMLElement).id];
    if (spec == null) {
      return;
    }
    if ((e.currentTarget as HTMLInputElement).disabled) {
      return;
    }
    beginInputScrub(e, spec);
  }

  /**
   * Forgets the tour and the tutorial and puts the tour back on screen.
   *
   * The same function as Help ▸ Reset Onboarding, so the two cannot disagree
   * about what a reset clears. No confirmation: the tour is a handful of Next
   * clicks and a Skip, and it writes its flag again on the way out.
   */
  private async _handleClickResetOnboarding() {
    await resetOnboardingAndTutorial();
  }

  _handleClickResolution(w, h) {
    if (this.editingTemplate) {
      return;
    }
    this.renderOption.previewSize.w = w;
    this.renderOption.previewSize.h = h;
    this.renderOptionStore.updateOptions(this.renderOption);
  }

  // ------------------------------------------------------------- the encoder

  /**
   * The settings as this build will honour them. A browser writes only what
   * WebCodecs can encode, so it shows a saved MOV or ProRes as the MP4 it will
   * actually write (`web/encodeSettings.ts`), without changing what is saved.
   */
  private get settings(): ExportSettings {
    const saved = this.renderOption.exportSettings;
    return this.inBrowser ? webExportSettings(saved) : saved;
  }

  private get inBrowser(): boolean {
    return getLocationEnv() !== "electron";
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
      : (this.inBrowser ? WEB_CONTAINER_VIDEO_CODECS[container as WebContainer] : CONTAINER_VIDEO_CODECS[container])[0];

    this.patch({ container, videoCodec });
  }

  /**
   * One `<select>` under its name, in the inspector kit's field, with `hint`
   * under it when there is one.
   *
   * `key` names the setting this select shows, so `updated()` can reconcile the
   * live selection against the store — see the note there.
   */
  private renderSelect(
    key: keyof ExportSettings,
    label: string,
    options: { value: string | number; label: string }[],
    handler: (e) => void,
    hint?: string,
  ) {
    const value = this.settings[key];

    return html`
      <div class="opt-field">
        <div class="opt-row">
          <label class="opt-label">${label}</label>
        </div>
        <select
          data-setting=${key}
          class="opt-select proj-control"
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
        ${hint == null
          ? ""
          : html`<div class="opt-hint proj-hint">${hint}</div>`}
      </div>
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
   * A checkbox, for the one setting that is a boolean, drawn as a switch at the
   * end of its name's row. `hint` is the line under it.
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
    hint: string,
  ) {
    return html`
      <div class="opt-field">
        <div class="opt-row">
          <label class="opt-label" for=${`export-${key}`}>${label}</label>
          <input
            class="proj-switch"
            type="checkbox"
            id=${`export-${key}`}
            data-setting=${key}
            ?checked=${checked}
            @change=${handler}
          />
        </div>
        <div class="opt-hint proj-hint">${hint}</div>
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
      ${section({
        title: this.lc.t("setting.video_duration"),
        body: html`
          <!-- The tutorial draws its ring around this row, so it holds the
               two boxes and nothing else. -->
          <div class="proj-pair" data-tutorial="project-duration">
            <div class="proj-unit-field">
              <input
                id="projectDurationMinute"
                type="number"
                class="proj-unit-input scrub-number"
                @mousedown=${this._handleScrubDown}
                placeholder="m"
                @change=${this._handleUpdateDurationMinute}
                .value=${String(Math.floor(duration / 60))}
                min="0"
              />
              <span class="proj-unit">${this.lc.t("setting.minute_unit")}</span>
            </div>

            <div class="proj-unit-field">
              <input
                id="projectDurationSecond"
                type="number"
                class="proj-unit-input scrub-number"
                @mousedown=${this._handleScrubDown}
                placeholder="${this.lc.t("setting.seconds")} e.g) 0"
                @change=${this._handleUpdateDurationSecond}
                .value=${String(duration % 60)}
                min="0"
              />
              <span class="proj-unit"
                >${this.lc.t("setting.seconds_unit")}</span
              >
            </div>
          </div>
        `,
      })}
      ${section({
        title: this.lc.t("setting.frame"),
        actions: html`
          <div class="proj-unit-field proj-unit-inline">
            <input
              id="projectFps"
              type="number"
              class="proj-unit-input scrub-number"
              @mousedown=${this._handleScrubDown}
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
            <span class="proj-unit">fps</span>
          </div>
        `,
      })}
      ${section({
        title: this.lc.t("setting.background"),
        actions: html`
          <input
            id="backgroundColor"
            type="color"
            class="opt-swatch"
            .value=${this.renderOption.backgroundColor}
            @change=${this._handleUpdateBackgroundColor}
            @input=${this._handleUpdateBackgroundColor}
          />
        `,
      })}
      ${section({
        title: this.lc.t("setting.resolution"),
        body: html`
          <div class="opt-field">
            <div class="proj-pair">
              <div class="proj-unit-field">
                <input
                  id="previewSizeH"
                  type="number"
                  class="proj-unit-input scrub-number"
                  ?disabled=${this.editingTemplate}
                  @mousedown=${this._handleScrubDown}
                  .value=${String(this.renderOption.previewSize.h)}
                  @change=${this._handleUpdatePreviewSizeH}
                />
              </div>
              <div class="proj-unit-field">
                <input
                  id="previewSizeW"
                  type="number"
                  class="proj-unit-input scrub-number"
                  ?disabled=${this.editingTemplate}
                  @mousedown=${this._handleScrubDown}
                  .value=${String(this.renderOption.previewSize.w)}
                  @change=${this._handleUpdatePreviewSizeW}
                />
              </div>
            </div>
          </div>
          <div class="opt-field">${this.renderResolutionPresets()}</div>
          ${this.editingTemplate
            ? html`<div class="opt-hint proj-hint">
                ${this.lc.t("setting.resolution_in_template") ||
                "The project's resolution. A template's own timeline keeps the size it was made at, so this is set from the Main tab."}
              </div>`
            : ""}
        `,
      })}
    `;
  }

  /**
   * Four tiles in one row, each drawing its own aspect ratio.
   *
   * The inspector kit's tiles (`opt-tile`), held at four columns by
   * `.proj-tiles`. Not `.btn`: the design system pins its padding with
   * `!important`, which is wider than a quarter of the sidebar and is why these
   * used to stack.
   */
  private renderResolutionPresets() {
    const { w, h } = this.renderOption.previewSize;

    return html`
      <div class="opt-tiles proj-tiles">
        ${RESOLUTION_PRESETS.map((preset) => {
          const scale = RATIO_GLYPH_PX / Math.max(preset.w, preset.h);
          const active = preset.w === w && preset.h === h;

          return html`
            <button
              type="button"
              class="opt-tile ${active ? "is-on" : ""}"
              ?disabled=${this.editingTemplate}
              title=${preset.title}
              @click=${() => this._handleClickResolution(preset.w, preset.h)}
            >
              <span
                class="proj-tile-glyph"
                style="width: ${RATIO_GLYPH_PX}px; height: ${RATIO_GLYPH_PX}px;"
              >
                <span
                  class="opt-tile-shape"
                  style="width: ${Math.round(
                    preset.w * scale,
                  )}px; height: ${Math.round(preset.h * scale)}px;"
                ></span>
              </span>
              <span class="opt-tile-label">${preset.ratio}</span>
              <span class="proj-tile-tag">${preset.tag}</span>
            </button>
          `;
        })}
      </div>
    `;
  }

  private renderVideoSection() {
    const settings = this.settings;
    const isProRes = settings.videoCodec === "prores";
    const isGif = settings.videoCodec === "gif";
    // Neither has a rate to control: ProRes is fixed per profile, and a GIF's
    // size is its frame rate, its width and its 256 colours.
    const hasRateControl = !isProRes && !isGif;
    const crfRange = CRF_RANGE[settings.videoCodec];
    // VideoToolbox is a macOS facility, and VP9 has no encoder on it. Where
    // neither holds the toggle is not shown at all rather than shown inert.
    // A browser picks its own encoder, hardware where it has one.
    const canHardwareAccel =
      !this.inBrowser && IS_MAC && CODEC_SUPPORTS_HW_ACCEL[settings.videoCodec];
    const hardwareActive = canHardwareAccel && settings.hardwareAccel;

    return html`
      ${this.renderSelect(
        "container",
        this.lc.t("setting.container"),
        (this.inBrowser ? WEB_CONTAINERS : CONTAINERS).map((container) => ({
          value: container,
          label: CONTAINER_LABELS[container],
        })),
        (e) => this._handleChangeContainer(e),
      )}
      ${this.renderSelect(
        "videoCodec",
        this.lc.t("setting.video_codec"),
        (this.inBrowser
          ? WEB_CONTAINER_VIDEO_CODECS[settings.container as WebContainer]
          : CONTAINER_VIDEO_CODECS[settings.container]
        ).map((codec) => ({
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
      ${hasRateControl && settings.qualityMode === "crf"
        ? html`
            <div class="opt-field">
              <div class="opt-row">
                <label class="opt-label">${this.lc.t("setting.crf")}</label>
                <span class="opt-value">${settings.crf}</span>
              </div>
              <input
                type="range"
                class="opt-slider"
                style="--opt-fill: ${fillPercent(
                  settings.crf,
                  crfRange.min,
                  crfRange.max,
                )};"
                min=${crfRange.min}
                max=${crfRange.max}
                .value=${String(settings.crf)}
                @input=${(e) => this.patch({ crf: Number(e.target.value) })}
              />
              <div class="opt-hint proj-hint">
                ${this.lc.t("setting.crf_hint")}
              </div>
            </div>
          `
        : ""}
      ${hasRateControl && settings.qualityMode === "bitrate"
        ? html`
            <div class="opt-field">
              <div class="opt-row">
                <label class="opt-label">${this.lc.t("setting.bitrate")}</label>
              </div>
              <div class="proj-unit-field proj-control">
                <input
                  id="videoBitrate"
                  type="number"
                  class="proj-unit-input scrub-number"
                  @mousedown=${this._handleScrubDown}
                  min="1"
                  .value=${String(settings.videoBitrate)}
                  @change=${(e) =>
                    this.patch({ videoBitrate: Number(e.target.value) })}
                />
                <span class="proj-unit"
                  >${this.lc.t("setting.bitrate_unit")}</span
                >
              </div>
            </div>
          `
        : ""}
      ${canHardwareAccel
        ? this.renderCheckbox(
            "hardwareAccel",
            this.lc.t("setting.hardware_accel"),
            settings.hardwareAccel,
            (e) => this.patch({ hardwareAccel: e.target.checked }),
            this.lc.t(
              isProRes || settings.videoCodec === "h265"
                ? "setting.hardware_accel_hint"
                : "setting.hardware_accel_hint_h264",
            ),
          )
        : ""}
      ${CODEC_SUPPORTS_SPEED_PRESET[settings.videoCodec] && !hardwareActive && !this.inBrowser
        ? this.renderSelect(
            "preset",
            this.lc.t("setting.encode_preset"),
            ENCODE_PRESETS.map((preset) => ({ value: preset, label: preset })),
            (e) => this.patch({ preset: e.target.value }),
          )
        : ""}
      ${isGif
        ? html`
            ${this.renderSelect(
              "gifFps",
              this.lc.t("setting.gif_fps"),
              GIF_FPS.map((fps) => ({ value: fps, label: `${fps} fps` })),
              (e) => this.patch({ gifFps: Number(e.target.value) }),
            )}
            ${this.renderSelect(
              "gifWidth",
              this.lc.t("setting.gif_width"),
              GIF_WIDTHS.map((width) => ({
                value: width,
                label:
                  width === 0 ? this.lc.t("setting.gif_width_original") : gifWidthLabel(width),
              })),
              (e) => this.patch({ gifWidth: Number(e.target.value) }),
              this.lc.t("setting.gif_hint"),
            )}
          `
        : ""}
      ${isProRes
        ? this.renderSelect(
            "proresProfile",
            this.lc.t("setting.prores_profile"),
            PRORES_PROFILES.map((profile) => ({
              value: profile.value,
              label: profile.label,
            })),
            (e) => this.patch({ proresProfile: Number(e.target.value) }),
            this.lc.t("setting.prores_hint"),
          )
        : ""}
    `;
  }

  private renderAudioSection() {
    const settings = this.settings;

    if (CONTAINER_AUDIO_CODECS[settings.container].length === 0) {
      return html`<div class="opt-hint proj-hint">${this.lc.t("setting.gif_no_audio")}</div>`;
    }

    return html`
      ${this.renderSelect(
        "audioCodec",
        this.lc.t("setting.audio_codec"),
        (this.inBrowser
          ? WEB_CONTAINER_AUDIO_CODECS[settings.container as WebContainer]
          : CONTAINER_AUDIO_CODECS[settings.container]
        ).map((codec) => ({
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

  /**
   * Two cards: the preset row with its summary line, and the codec detail,
   * whose head is the disclosure that opens it.
   */
  private renderExportPane() {
    const activePreset = detectPreset(this.settings);

    return html`
      ${section({
        title: this.lc.t("setting.export_preset"),
        body: html`
          <div class="opt-seg" role="group">
            ${PRESET_NAMES.map(
              (name) => html`
                <button
                  type="button"
                  class="opt-seg-item ${activePreset === name ? "is-on" : ""}"
                  aria-pressed=${activePreset === name ? "true" : "false"}
                  @click=${() => this._handleClickPreset(name)}
                >
                  <span class="proj-seg-label"
                    >${this.lc.t(`setting.preset_${name}`)}</span
                  >
                </button>
              `,
            )}
            <button
              type="button"
              class="opt-seg-item ${activePreset === "custom" ? "is-on" : ""}"
              aria-pressed=${activePreset === "custom" ? "true" : "false"}
              @click=${() => (this.showAdvanced = true)}
            >
              <span class="proj-seg-label"
                >${this.lc.t("setting.preset_custom")}</span
              >
            </button>
          </div>

          <div class="opt-hint" style="margin-top: 8px;">
            ${describeExportSettings(this.settings)}
          </div>
        `,
      })}

      <div class="opt-section">
        <button
          type="button"
          class="opt-head proj-disclosure"
          aria-expanded=${this.showAdvanced ? "true" : "false"}
          @click=${() => (this.showAdvanced = !this.showAdvanced)}
        >
          <span class="opt-head-title"
            >${this.lc.t("setting.advanced_settings")}</span
          >
          <span class="material-symbols-outlined proj-disclosure-icon">
            ${this.showAdvanced ? "expand_less" : "expand_more"}
          </span>
        </button>

        <div class="opt-body ${this.showAdvanced ? "" : "d-none"}">
          ${this.renderVideoSection()} ${this.renderAudioSection()}
        </div>
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
   * The shortcuts button, the tour reset and the version, below both panes.
   * The language moved to the settings dialog (`features/settings/`).
   *
   * Not in either tab because they belong to neither. Save and Load used to sit
   * here too; they are File → Save Project (⌘S) and Open Project (⌘O), and a
   * second copy of a menu command is the thing that goes stale.
   *
   * The reset carries its label rather than sitting beside the keyboard icon:
   * that is a conventional glyph, and nothing about an icon says which of the
   * app's several things a reset would put back.
   */
  private renderCommonSection() {
    return html`
      <button
        type="button"
        class="browse-btn"
        data-bs-toggle="modal"
        data-bs-target="#shortKey"
      >
        <span class="material-symbols-outlined"> keyboard </span>
      </button>

      <!-- <button
        type="button"
        class="btn btn-sm btn-default text-light w-100 mt-2 d-flex justify-content-between align-items-center"
        @click=${this._handleClickResetOnboarding}
      >
        <span>${this.lc.t("setting.reset_onboarding")}</span>
        <span class="material-symbols-outlined"> restart_alt </span>
      </button> -->

      <p class="proj-version" ref="appVersion">${this.appVersion}</p>
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

      <hr class="proj-rule" />

      ${this.renderCommonSection()}
    `;
  }
}

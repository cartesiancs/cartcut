/**
 * The settings dialog, opened from the gear beside Export.
 *
 * The shell is `mediaInfo/mediaInfoDialog.ts`'s, for the reasons it gives: a
 * dark overlay of its own rather than a Bootstrap modal (the vendored 5.0.2
 * comes up white), light DOM, every handler an arrow property, keys caught in
 * the capture phase on `window`, and focus handed back on close. Added here: a
 * Tab trap (`automatic-caption/src/clipPicker.ts`), typing passed through so
 * copy and paste still work in the address field, and a sidebar of sections:
 * General (the language, which used to be a Bootstrap modal of its own) and
 * the cloud, which can also delete everything downloaded from it, and
 * storage: the temporary files, the screen recorder's takes, and the folders
 * where the app keeps its files.
 *
 * Words are kept to labels. A row says what it controls in a word or two, and
 * the only sentence anywhere is an error.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

import { LocaleController } from "../../controllers/locale";
import { isTypingEvent } from "../../utils/typingTarget";
import { isProjectDirty } from "../project/projectDirty";
import {
  clearCloudDownloads,
  cloudInstallSummary,
  cloudStore,
  setCloudEnabled,
  setCloudUrl,
  subscribeCloudListing,
} from "../cloud/cloudStore";
import { loadPresets } from "../fx/presetRegistry";
import { refreshTemplateLibrary } from "../template/templateRegistry";
import { criticalDamping, springDurationMs, springEasing, type Spring } from "../motion/spring";
import {
  clearRecordingFiles,
  clearTempFiles,
  openStorageFolder,
  readRecordingsSummary,
  readTempSummary,
  storagePort,
  type StorageFolder,
} from "./storagePort";

type Section = "general" | "cloud" | "storage";

const SECTIONS: ReadonlyArray<{ id: Section; icon: string; label: string }> = [
  { id: "general", icon: "tune", label: "setting.section_general" },
  { id: "cloud", icon: "cloud", label: "setting.section_cloud" },
  { id: "storage", icon: "hard_drive", label: "setting.section_storage" },
];

/** The folders Storage can open. Recordings opens from its own row. */
const FOLDERS: ReadonlyArray<{ id: StorageFolder; label: string }> = [
  { id: "appData", label: "setting.storage_folder_app_data" },
  { id: "autosave", label: "setting.storage_folder_autosave" },
  { id: "logs", label: "setting.storage_folder_logs" },
  { id: "temp", label: "setting.storage_folder_temp" },
];

type Language = "en" | "ko";

/** Each in its own language, so someone who cannot read the other can find theirs. */
const LANGUAGES: ReadonlyArray<{ id: Language; label: string }> = [
  { id: "en", label: "English" },
  { id: "ko", label: "한국어" },
];

/**
 * A touch under critical: the panel settles with the faintest give and never
 * visibly bounces, which on a dialog would read as a toy.
 */
const OPEN_SPRING: Spring = {
  stiffness: 700,
  damping: criticalDamping({ stiffness: 700 }) * 0.82,
};
/** shadcn's `zoom-in-95`, one step shallower: a 620px panel travels far enough. */
const OPEN_FROM = 0.96;
const FADE_MS = 140;
/** Flat and quick on the way out, matching `_settings.scss`. */
const EXIT_MS = 120;

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), [tabindex='0']";

/** A size the way a file browser shows one: whole kilobytes, then one decimal. */
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return Math.max(1, Math.round(bytes / 1024)) + " KB";
  }
  if (bytes < 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

@customElement("settings-dialog")
export class SettingsDialog extends LitElement {
  @state() private isOpen = false;
  @state() private leaving = false;
  @state() private section: Section = "general";
  /**
   * The language picked here, which takes effect at the next launch. `null`
   * until the dialog first opens, then whatever was last picked.
   *
   * Written to the store directly rather than through `lc.changeLanguage`,
   * which would switch this dialog alone and leave the rest of the app in the
   * old language: every `LocaleController` reads `LANG` once, when it
   * connects. `this.lc.value` therefore stays the language the app is running
   * in, and the two differ exactly while a restart is owed.
   */
  @state() private language: Language | null = null;
  /** Whether main refused the last address typed into the server field. */
  @state() private urlError = false;
  /** What is downloaded from the cloud, counted when the dialog opens; `null` until main answers. */
  @state() private downloaded: { items: number; bytes: number } | null = null;
  @state() private clearing = false;
  /** Whether the last delete left something behind (a file another program held open). */
  @state() private clearFailed = false;
  /** The temporary files' size, counted when the dialog opens; `null` until main answers. */
  @state() private temp: { bytes: number } | null = null;
  @state() private clearingTemp = false;
  @state() private tempFailed = false;
  /** The recorder's finished takes, counted when the dialog opens. */
  @state() private recordings: { files: number; bytes: number } | null = null;
  @state() private clearingRecordings = false;
  /** `busy` when main refused because a take is running. */
  @state() private recordingsError: "failed" | "busy" | null = null;
  /** The folder whose Open last failed, so the error sits under its row. */
  @state() private openFailed: StorageFolder | null = null;

  private lc = new LocaleController(this);
  private returnFocus: HTMLElement | null = null;
  private releaseCloud: (() => void) | null = null;
  private leaveTimer = 0;

  createRenderRoot() {
    // Or the timeline canvas's document-level mousedown clears the clip
    // selection on every click inside the dialog.
    this.setAttribute("data-keeps-selection", "");
    return this;
  }

  open(): void {
    if (this.isOpen && !this.leaving) {
      return;
    }
    window.clearTimeout(this.leaveTimer);
    if (!this.isOpen) {
      this.returnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    window.addEventListener("keydown", this.onKeydown, true);
    this.releaseCloud ??= subscribeCloudListing(() => this.requestUpdate());
    this.isOpen = true;
    this.leaving = false;
    this.urlError = false;
    this.clearFailed = false;
    this.tempFailed = false;
    this.recordingsError = null;
    this.openFailed = null;
    this.language ??= this.lc.value;
    void this.readDownloaded();
    void this.readStorage();

    // The panel itself takes focus, not its first control: a ring around a
    // nav item nobody pressed is noise, and the next Tab lands on that item.
    void this.updateComplete.then(() => {
      this.animateIn();
      this.querySelector<HTMLElement>(".settings-panel")?.focus();
    });
  }

  close(): void {
    if (!this.isOpen || this.leaving) {
      return;
    }
    window.removeEventListener("keydown", this.onKeydown, true);
    this.releaseCloud?.();
    this.releaseCloud = null;

    // Unmounted once the fade has run, so the exit is seen.
    this.leaving = true;
    this.leaveTimer = window.setTimeout(
      () => {
        this.isOpen = false;
        this.leaving = false;
      },
      prefersReducedMotion() ? 0 : EXIT_MS,
    );

    const focus = this.returnFocus;
    this.returnFocus = null;
    focus?.focus();
  }

  disconnectedCallback(): void {
    window.removeEventListener("keydown", this.onKeydown, true);
    window.clearTimeout(this.leaveTimer);
    this.releaseCloud?.();
    this.releaseCloud = null;
    super.disconnectedCallback();
  }

  /**
   * The scrim fades; the panel fades and springs up from `OPEN_FROM`. The
   * scale is dropped under reduced motion and the fade kept, the rule
   * `_asset.scss` follows for the tile hover.
   */
  private animateIn(): void {
    const scrim = this.querySelector<HTMLElement>(".settings-scrim");
    const panel = this.querySelector<HTMLElement>(".settings-panel");
    if (scrim == null || panel == null || typeof panel.animate !== "function") {
      return;
    }
    const fade = { duration: FADE_MS, easing: "ease-out" };
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], fade);
    panel.animate([{ opacity: 0 }, { opacity: 1 }], fade);
    if (!prefersReducedMotion()) {
      panel.animate([{ transform: `scale(${OPEN_FROM})` }, { transform: "none" }], {
        duration: springDurationMs(OPEN_SPRING),
        easing: springEasing(OPEN_SPRING),
      });
    }
  }

  /**
   * Capture phase on `window`, ahead of the timeline's own handlers. Escape
   * closes and Tab stays inside. Anything typed into the address field goes
   * on to it, and to `textEditing.ts`, which is what makes copy and paste work
   * there. Every other key stops here: behind the dialog, Space would start
   * playback and Delete would remove the selected clip. Default actions are
   * left alone, so Space still flips a focused switch.
   */
  private onKeydown = (event: KeyboardEvent): void => {
    if (!this.isOpen || this.leaving || event.isComposing) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.close();
      return;
    }
    if (event.key === "Tab") {
      event.stopImmediatePropagation();
      this.trapTab(event);
      return;
    }
    if (isTypingEvent(event)) {
      return;
    }
    event.stopImmediatePropagation();
  };

  private trapTab(event: KeyboardEvent): void {
    const panel = this.querySelector(".settings-panel");
    if (panel == null) {
      return;
    }
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const inside = active != null && panel.contains(active);
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  }

  private onScrimDown = (event: PointerEvent): void => {
    // Only a press that starts on the scrim itself. A drag that selects text
    // in the address field and is released outside must not close it.
    if (event.target === event.currentTarget) {
      this.close();
    }
  };

  private onClose = (): void => {
    this.close();
  };

  private onToggleCloud = (): void => {
    void setCloudEnabled(!cloudStore.getState().enabled);
  };

  /** On commit (Enter or leaving the field): each accepted address drops the catalogs. */
  private onUrlChange = async (event: Event): Promise<void> => {
    this.urlError = !(await setCloudUrl((event.target as HTMLInputElement).value));
  };

  private onUrlInput = (): void => {
    this.urlError = false;
  };

  private onUrlReset = async (): Promise<void> => {
    const input = this.querySelector<HTMLInputElement>("#settings-cloud-url");
    if (input != null) {
      input.value = "";
    }
    this.urlError = !(await setCloudUrl(""));
    input?.focus();
  };

  private readDownloaded = async (): Promise<void> => {
    this.downloaded = await cloudInstallSummary();
  };

  /**
   * Main picks the folders; nothing here names one. Afterwards the preset and
   * template registries are re-read, so a deleted item leaves its panel, and a
   * clip still using one draws nothing, the contract for any missing preset.
   */
  private onClearDownloads = async (): Promise<void> => {
    const count = this.downloaded?.items ?? 0;
    if (count === 0 || this.clearing) {
      return;
    }
    if (!window.confirm(this.lc.t("setting.cloud_clear_confirm").replace("{n}", String(count)))) {
      return;
    }
    this.clearing = true;
    this.clearFailed = false;
    const result = await clearCloudDownloads();
    await Promise.all([loadPresets(), refreshTemplateLibrary()]);
    this.clearFailed = result == null || !result.ok;
    this.clearing = false;
    await this.readDownloaded();
  };

  private readStorage = async (): Promise<void> => {
    const [temp, recordings] = await Promise.all([readTempSummary(), readRecordingsSummary()]);
    this.temp = temp;
    this.recordings = recordings;
  };

  /** Main picks what is temporary; anything a clip points at is never in it. */
  private onClearTemp = async (): Promise<void> => {
    const bytes = this.temp?.bytes ?? 0;
    if (bytes === 0 || this.clearingTemp) {
      return;
    }
    if (!window.confirm(this.lc.t("setting.storage_temp_confirm").replace("{size}", formatBytes(bytes)))) {
      return;
    }
    this.clearingTemp = true;
    this.tempFailed = false;
    const result = await clearTempFiles();
    this.tempFailed = result == null || !result.ok;
    this.clearingTemp = false;
    await this.readStorage();
  };

  /** To the Trash, so a take deleted by mistake can still be put back. */
  private onClearRecordings = async (): Promise<void> => {
    const recordings = this.recordings;
    if (recordings == null || recordings.files === 0 || this.clearingRecordings) {
      return;
    }
    const question = this.lc
      .t("setting.storage_recordings_confirm")
      .replace("{n}", String(recordings.files))
      .replace("{size}", formatBytes(recordings.bytes));
    if (!window.confirm(question)) {
      return;
    }
    this.clearingRecordings = true;
    this.recordingsError = null;
    const result = await clearRecordingFiles();
    this.recordingsError = result?.busy === true ? "busy" : result?.ok === true ? null : "failed";
    this.clearingRecordings = false;
    await this.readStorage();
  };

  private onOpenFolder = async (folder: StorageFolder): Promise<void> => {
    this.openFailed = null;
    if (!(await openStorageFolder(folder))) {
      this.openFailed = folder;
    }
  };

  private onPickLanguage = (language: Language): void => {
    this.language = language;
    void window.electronAPI?.req?.store?.set("LANG", language);
  };

  /**
   * `app:restart` exits without the unsaved-project guard, so the question is
   * asked here, and only when there is something to lose: the update card's
   * rule and its wording (`updatePrompt.ts`).
   */
  private onRestart = (): void => {
    if (isProjectDirty() && !window.confirm(this.lc.t("update.unsaved_confirm"))) {
      return;
    }
    window.electronAPI?.req?.app?.restart?.();
  };

  private generalSection() {
    const t = (key: string) => this.lc.t(key);
    const chosen = this.language ?? this.lc.value;
    const owed = chosen !== this.lc.value;

    return html`
      <div class="settings-group">
        <div class="settings-row">
          <span class="settings-label" id="settings-language-label">
            ${t("setting.language")}
          </span>
          <div class="settings-row-control is-end">
            <div
              class="settings-seg"
              role="radiogroup"
              aria-labelledby="settings-language-label"
            >
              ${LANGUAGES.map(
                (language) => html`
                  <button
                    type="button"
                    role="radio"
                    class="settings-seg-item ${language.id === chosen ? "is-on" : ""}"
                    aria-checked=${language.id === chosen ? "true" : "false"}
                    lang=${language.id}
                    @click=${() => this.onPickLanguage(language.id)}
                  >
                    ${language.label}
                  </button>
                `,
              )}
            </div>
            ${owed
              ? html`<div class="settings-note">
                  <span>${t("setting.restart_to_apply")}</span>
                  <button type="button" class="settings-text-btn" @click=${this.onRestart}>
                    ${t("setting.restart")}
                  </button>
                </div>`
              : nothing}
          </div>
        </div>
      </div>
    `;
  }

  private cloudSection() {
    const cloud = cloudStore.getState();
    // No bridge on the web build: the rows stay, so the dialog does not change
    // shape between builds, and say by being disabled that there is nothing
    // to set.
    const disabled = !cloud.available;
    const t = (key: string) => this.lc.t(key);

    return html`
      <div class="settings-group">
        <div class="settings-row">
          <label class="settings-label" for="settings-cloud-switch">
            ${t("setting.cloud_content")}
          </label>
          <button
            id="settings-cloud-switch"
            type="button"
            class="settings-switch"
            role="switch"
            aria-checked=${cloud.enabled && !disabled ? "true" : "false"}
            ?disabled=${disabled}
            @click=${this.onToggleCloud}
          ></button>
        </div>

        <div class="settings-row">
          <label class="settings-label" for="settings-cloud-url">
            ${t("setting.cloud_url")}
          </label>
          <div class="settings-row-control">
            <div class="settings-field ${this.urlError ? "is-invalid" : ""}">
              <input
                id="settings-cloud-url"
                class="settings-input"
                type="url"
                spellcheck="false"
                autocomplete="off"
                placeholder=${cloud.defaultUrl ?? ""}
                aria-invalid=${this.urlError ? "true" : "false"}
                .value=${cloud.customUrl ? (cloud.url ?? "") : ""}
                ?disabled=${disabled}
                @input=${this.onUrlInput}
                @change=${this.onUrlChange}
              />
              ${cloud.customUrl
                ? html`<button
                    type="button"
                    class="settings-field-btn"
                    title=${t("setting.cloud_url_reset")}
                    aria-label=${t("setting.cloud_url_reset")}
                    @click=${this.onUrlReset}
                  >
                    <span class="material-symbols-outlined">restart_alt</span>
                  </button>`
                : nothing}
            </div>
            ${this.urlError
              ? html`<div class="settings-error">${t("setting.cloud_url_invalid")}</div>`
              : nothing}
          </div>
        </div>

        <div class="settings-row">
          <span class="settings-label">${t("setting.cloud_downloads")}</span>
          <div class="settings-row-control is-end">
            <div class="settings-inline">
              <span class="settings-value">${this.downloadedText()}</span>
              <button
                type="button"
                class="settings-text-btn is-danger"
                ?disabled=${disabled || this.clearing || (this.downloaded?.items ?? 0) === 0}
                @click=${this.onClearDownloads}
              >
                ${t("setting.cloud_clear")}
              </button>
            </div>
            ${this.clearFailed
              ? html`<div class="settings-error">${t("setting.cloud_clear_failed")}</div>`
              : nothing}
          </div>
        </div>
      </div>
    `;
  }

  private storageSection() {
    const t = (key: string) => this.lc.t(key);
    // No bridge on the web build: the rows stay and are disabled, as the cloud's are.
    const disabled = storagePort() == null;
    const openFailed = (folder: StorageFolder) =>
      this.openFailed === folder
        ? html`<div class="settings-error">${t("setting.storage_open_failed")}</div>`
        : nothing;

    return html`
      <div class="settings-group">
        <div class="settings-row">
          <span class="settings-label">${t("setting.storage_temp")}</span>
          <div class="settings-row-control is-end">
            <div class="settings-inline">
              <span class="settings-value">${this.tempText()}</span>
              <button
                type="button"
                class="settings-text-btn is-danger"
                ?disabled=${disabled || this.clearingTemp || (this.temp?.bytes ?? 0) === 0}
                @click=${this.onClearTemp}
              >
                ${t("setting.storage_delete")}
              </button>
            </div>
            ${this.tempFailed
              ? html`<div class="settings-error">${t("setting.storage_failed")}</div>`
              : nothing}
          </div>
        </div>

        <div class="settings-row">
          <span class="settings-label">${t("setting.storage_recordings")}</span>
          <div class="settings-row-control is-end">
            <div class="settings-inline">
              <span class="settings-value">${this.recordingsText()}</span>
              <button
                type="button"
                class="settings-text-btn"
                ?disabled=${disabled}
                @click=${() => this.onOpenFolder("recordings")}
              >
                ${t("setting.storage_open")}
              </button>
              <button
                type="button"
                class="settings-text-btn is-danger"
                ?disabled=${disabled ||
                this.clearingRecordings ||
                (this.recordings?.files ?? 0) === 0}
                @click=${this.onClearRecordings}
              >
                ${t("setting.storage_delete")}
              </button>
            </div>
            ${this.recordingsError != null
              ? html`<div class="settings-error">
                  ${t(
                    this.recordingsError === "busy"
                      ? "setting.storage_recording_busy"
                      : "setting.storage_failed",
                  )}
                </div>`
              : nothing}
            ${openFailed("recordings")}
          </div>
        </div>
      </div>

      <div class="settings-group">
        ${FOLDERS.map(
          (folder) => html`
            <div class="settings-row">
              <span class="settings-label">${t(folder.label)}</span>
              <div class="settings-row-control is-end">
                <button
                  type="button"
                  class="settings-text-btn"
                  ?disabled=${disabled}
                  @click=${() => this.onOpenFolder(folder.id)}
                >
                  ${t("setting.storage_open")}
                </button>
                ${openFailed(folder.id)}
              </div>
            </div>
          `,
        )}
      </div>
    `;
  }

  /** "34.5 MB", "None", or nothing while main has not answered. */
  private tempText(): string {
    if (this.temp == null) {
      return "";
    }
    return this.temp.bytes === 0 ? this.lc.t("setting.storage_none") : formatBytes(this.temp.bytes);
  }

  /** "43 files, 412.0 MB", "None", or nothing while main has not answered. */
  private recordingsText(): string {
    const recordings = this.recordings;
    if (recordings == null) {
      return "";
    }
    if (recordings.files === 0) {
      return this.lc.t("setting.storage_none");
    }
    return this.lc
      .t("setting.storage_recordings_summary")
      .replace("{n}", String(recordings.files))
      .replace("{size}", formatBytes(recordings.bytes));
  }

  private currentSection(section: Section) {
    switch (section) {
      case "general":
        return this.generalSection();
      case "cloud":
        return this.cloudSection();
      case "storage":
        return this.storageSection();
    }
  }

  /** "12 items, 34.5 MB", "None", or nothing while main has not answered. */
  private downloadedText(): string {
    const downloaded = this.downloaded;
    if (downloaded == null) {
      return "";
    }
    if (downloaded.items === 0) {
      return this.lc.t("setting.cloud_downloads_none");
    }
    return this.lc
      .t("setting.cloud_downloads_summary")
      .replace("{n}", String(downloaded.items))
      .replace("{size}", formatBytes(downloaded.bytes));
  }

  render() {
    if (!this.isOpen) {
      return nothing;
    }
    const t = (key: string) => this.lc.t(key);
    const current = SECTIONS.find((section) => section.id === this.section) ?? SECTIONS[0];

    return html`
      <div
        class="settings-scrim ${this.leaving ? "is-leaving" : ""}"
        @pointerdown=${this.onScrimDown}
      >
        <div
          class="settings-panel"
          tabindex="-1"
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-title"
        >
          <nav class="settings-nav" aria-labelledby="settings-title">
            <div class="settings-title" id="settings-title">
              ${t("setting.settings_title")}
            </div>
            ${SECTIONS.map(
              (section) => html`
                <button
                  type="button"
                  class="settings-nav-item ${section.id === current.id ? "is-on" : ""}"
                  aria-current=${section.id === current.id ? "page" : "false"}
                  @click=${() => (this.section = section.id)}
                >
                  <span class="material-symbols-outlined settings-nav-icon"
                    >${section.icon}</span
                  >
                  <span>${t(section.label)}</span>
                </button>
              `,
            )}
          </nav>

          <div class="settings-main">
            <div class="settings-main-head">
              <div class="settings-main-title">${t(current.label)}</div>
              <button
                type="button"
                class="settings-close"
                title=${t("setting.close")}
                aria-label=${t("setting.close")}
                @click=${this.onClose}
              >
                <span class="material-symbols-outlined">close</span>
              </button>
            </div>
            <div class="settings-main-body">
              ${this.currentSection(current.id)}
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

/** Open the dialog, wherever it is mounted (`App.ts`). */
export function openSettings(): void {
  (document.querySelector("settings-dialog") as SettingsDialog | null)?.open();
}

/**
 * The settings dialog, opened from the gear beside Export.
 *
 * The shell is `mediaInfo/mediaInfoDialog.ts`'s, for the reasons it gives: a
 * dark overlay of its own rather than a Bootstrap modal (the vendored 5.0.2
 * comes up white), light DOM, every handler an arrow property, keys caught in
 * the capture phase on `window`, and focus handed back on close. Added here: a
 * Tab trap (`automatic-caption/src/clipPicker.ts`), typing passed through so
 * copy and paste still work in the address field, and a sidebar of sections,
 * of which the cloud is the first.
 *
 * Words are kept to labels. A row says what it controls in a word or two, and
 * the only sentence anywhere is an error.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

import { LocaleController } from "../../controllers/locale";
import { isTypingEvent } from "../../utils/typingTarget";
import {
  cloudStore,
  setCloudEnabled,
  setCloudUrl,
  subscribeCloudListing,
} from "../cloud/cloudStore";
import { criticalDamping, springDurationMs, springEasing, type Spring } from "../motion/spring";

type Section = "cloud";

const SECTIONS: ReadonlyArray<{ id: Section; icon: string; label: string }> = [
  { id: "cloud", icon: "cloud", label: "setting.section_cloud" },
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

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

@customElement("settings-dialog")
export class SettingsDialog extends LitElement {
  @state() private isOpen = false;
  @state() private leaving = false;
  @state() private section: Section = "cloud";
  /** Whether main refused the last address typed into the server field. */
  @state() private urlError = false;

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
      </div>
    `;
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
            <div class="settings-main-body">${this.cloudSection()}</div>
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

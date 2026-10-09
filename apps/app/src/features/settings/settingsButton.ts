/**
 * The gear beside Export in the title bar. Opens `<settings-dialog>`.
 *
 * Styled in `_settings.scss` as a bare glyph the height of the Export pill,
 * with a soft round fill on hover and keyboard focus.
 */

import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";

import { LocaleController } from "../../controllers/locale";
import { openSettings } from "./settingsDialog";

@customElement("settings-button")
export class SettingsButton extends LitElement {
  private lc = new LocaleController(this);

  createRenderRoot() {
    return this;
  }

  private onClick = (): void => {
    openSettings();
  };

  render() {
    const label = this.lc.t("setting.settings_title");
    return html`<button
      type="button"
      class="settings-trigger"
      title=${label}
      aria-label=${label}
      aria-haspopup="dialog"
      @click=${this.onClick}
    >
      <span class="material-symbols-outlined settings-trigger-icon">settings</span>
    </button>`;
  }
}

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LocaleController } from "../../controllers/locale";

@customElement("background-remove")
export class BackgroundRemove extends LitElement {
  constructor() {
    super();
  }

  @property()
  imagePath;

  @property()
  isLoad = false;

  private lc = new LocaleController(this);
  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <button
        type="button"
        class="opt-text-btn"
        style="width: 100%; justify-content: center; height: 26px;"
        ?disabled=${this.isLoad}
        @click=${this.handleClickRemove}
      >
        <span class="material-symbols-outlined" style="font-size: 14px;">
          ${this.isLoad ? "hourglass_top" : "auto_fix"}
        </span>
        ${this.isLoad ? "Removing" : "Remove background"}
      </button>
    `;
  }

  handleClickRemove() {
    this.isLoad = true;
    window.electronAPI.req.media
      .backgroundRemove(this.imagePath)
      .then((path) => {
        console.log(path.path);
        this.isLoad = false;
        this.dispatchEvent(
          new CustomEvent("onReturn", {
            detail: { path: path.path },
            bubbles: true,
            composed: true,
          }),
        );
      });
  }
}

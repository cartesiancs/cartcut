import { LitElement, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { LocaleController } from "../../controllers/locale";
import axios from "axios";
import { Buffer } from "buffer";

// Same unserved endpoint gifPreset.ts documents: nothing under electron/server
// answers /api/gif, so a failure is reported rather than thrown.
const TEMPLATE_SEARCH_ENDPOINT = "http://127.0.0.1:8000/api/gif";

@customElement("template-list")
export class TemplateList extends LitElement {
  returnArray: any = [];
  private loaded = false;
  private error = "";

  constructor() {
    super();
  }

  createRenderRoot() {
    return this;
  }

  // Loaded when the panel is actually shown, not at app start.
  load() {
    if (this.loaded) return;
    this.loaded = true;
    this.getTemplate();
  }

  @query("#searchTemplateInput") searchInput;

  async _handleClickGif(gifurl) {
    const response = await fetch(gifurl);
    const control = document.querySelector("element-control");

    if (!response.ok) {
      throw new Error(`Failed to fetch audio file: ${response.statusText}`);
    }

    const fileBlob = await response.blob();
    const arrayBuffer = await fileBlob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    window.electronAPI.req.stream
      .saveBufferToTempFile(buffer, "gif")
      .then((path) => {
        control.addGif(fileBlob, path.path);
      });
  }

  async getTemplate() {
    const searchText = this.querySelector(
      "#searchTemplateInput",
    ) as HTMLInputElement | null;
    const value = searchText?.value?.trim() || "_defcartcut";

    this.error = "";

    try {
      const request = await axios.get(
        `${TEMPLATE_SEARCH_ENDPOINT}?q=${encodeURIComponent(value)}`,
      );
      const result = request.data?.result?.data ?? [];
      this.returnArray = result.map(
        (element) => html`
          <div
            class="col-6 d-flex flex-column bd-highlight overflow-hidden mt-1 asset"
            @click=${() => this._handleClickGif(element.images.original.url)}
          >
            <img src=${element.images.original.url} />
          </div>
        `,
      );
    } catch (error) {
      this.returnArray = [];
      this.error = "Template search is unavailable.";
    }

    this.requestUpdate();
  }

  _handleKeyDown(event) {
    if (event.key === "Enter") {
      this.onSearch();
    }
  }

  onSearch() {
    const searchText = this.searchInput?.value.trim();
    if (searchText) {
      this.loaded = true;
      this.getTemplate();
    }
  }

  render() {
    return html` <label class="form-label text-light">Search Template</label>
      <div class="input-group mb-3">
        <input
          id="searchTemplateInput"
          type="text"
          class="form-control bg-default text-light"
          placeholder="search template..."
          value=""
          @keydown="${this._handleKeyDown}"
        />
      </div>

      ${this.error
        ? html`<div class="text-secondary px-2 mb-2">${this.error}</div>`
        : ""}

      <div class="row px-2">${this.returnArray}</div>`;
  }
}

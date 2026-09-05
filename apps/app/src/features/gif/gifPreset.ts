import { LitElement, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { LocaleController } from "../../controllers/locale";
import axios from "axios";
import { Buffer } from "buffer";

// A Giphy proxy that no bundled server provides — nothing under electron/server
// answers /api/gif, so this is only reachable against a separately run backend.
// The search therefore has to report a failure rather than throw one.
const GIF_SEARCH_ENDPOINT = "http://127.0.0.1:8000/api/gif";

@customElement("gif-preset")
export class ControlText extends LitElement {
  returnArray: any = [];
  private loaded = false;
  private error = "";

  constructor() {
    super();
  }

  createRenderRoot() {
    return this;
  }

  @query("#searchGifInput") searchInput;

  // The panel is hidden until its tab is picked, so the first search waits for
  // that rather than firing a request at app start.
  load() {
    if (this.loaded) return;
    this.loaded = true;
    this.getGif();
  }

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

  async getGif() {
    const searchText = this.querySelector(
      "#searchGifInput",
    ) as HTMLInputElement | null;
    const value = searchText?.value?.trim() || "_defcartcut";

    this.error = "";

    try {
      const request = await axios.get(
        `${GIF_SEARCH_ENDPOINT}?q=${encodeURIComponent(value)}`,
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
      this.error = "GIF search is unavailable.";
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
      this.getGif();
    }
  }

  render() {
    return html` <label class="form-label text-light">search giphy</label>
      <div class="input-group mb-3">
        <input
          id="searchGifInput"
          type="text"
          class="form-control bg-default text-light"
          placeholder="search giphy gif..."
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

import { LitElement, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { LocaleController } from "../../controllers/locale";
import axios from "axios";
import { Buffer } from "buffer";

@customElement("template-list")
export class TemplateList extends LitElement {
  returnArray: any;
  constructor() {
    super();
  }

  createRenderRoot() {
    this.getTemplate();
    return this;
  }

  @query("#searchGifInput") searchInput;

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
        console.log(path);
        control.addGif(fileBlob, path.path);
      });
  }

  async getTemplate() {
    const searchText = this.querySelector(
      "#searchGifInput",
    ) as HTMLInputElement | null;
    const value = searchText?.value?.trim() || "_defcartcut";

    const request = await axios.get(`http://127.0.0.1:8000/api/gif?q=${value}`);
    const result = request.data.result.data;
    this.returnArray = [];
    for (let index = 0; index < result.length; index++) {
      const element = result[index];
      this.returnArray.push(html`
        <div
          class="col-6 d-flex flex-column bd-highlight overflow-hidden mt-1 asset"
          @click=${() => this._handleClickGif(element.images.original.url)}
        >
          <img src=${element.images.original.url} />
        </div>
      `);
    }
    this.requestUpdate();
  }

  _handleKeyDown(event) {
    if (event.key === "Enter") {
      this.onSearch();
    }
  }

  onSearch() {
    const searchText = this.searchInput.value.trim();
    if (searchText) {
      this.getTemplate();
      console.log("검색어:", searchText);
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

      <div class="row px-2">${this.returnArray}</div>`;
  }
}

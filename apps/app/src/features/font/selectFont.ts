import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("select-font")
export class SelectFont extends LitElement {
  onChangeSelect: Event;
  fontname: string;
  type: string;
  path: string;
  constructor() {
    super();

    this.path = "";
    this.type = "";
    this.fontname = "";
    this.onChangeSelect = new Event("onChangeSelect");
  }

  render() {
    let template = this.template();
    this.innerHTML = template;
    this.insertFontLists();
  }

  template() {
    return `<select
        ref="lists"
        class="form-select text-light"
        aria-label="Default select examplsse"
      >
        <option selected>Select</option>
      </select>
      <style id="fontStyles" ref="fontStyles"></style> `;
  }

  insertFontLists() {
    window.electronAPI.req.font.getLists().then((result) => {
      if (result.status == 0) {
        return 0;
      }

      for (let index = 0; index < result.fonts.length; index++) {
        const font = result.fonts[index];
        const fontSelect: any = this.querySelector("select[ref='lists']");
        fontSelect.insertAdjacentHTML(
          "beforeend",
          `<option value-index="${index + 1}" value='${font.path}'>${
            font.name
          }</option>`,
        );
      }
    });
  }

  handleSelect() {
    const pathListDom: any = this.querySelector("select[ref='lists']");
    this.path = pathListDom.value;
    this.fontname = pathListDom.value
      .split("/")
      [pathListDom.value.split("/").length - 1].split(".")[0];
    this.type = pathListDom.value
      .split("/")
      [pathListDom.value.split("/").length - 1].split(".")[1];

    this.applyFontStyle({
      fontName: this.fontname,
      fontPath: this.path,
      fontType: this.type,
    });

    this.dispatchEvent(this.onChangeSelect);
  }

  applyFontStyle({ fontName, fontPath, fontType }) {
    // fontStyle.insertAdjacentHTML(
    //   "beforeend",
    //   `
    //     @font-face {
    //         font-family: "${fontName}";
    //         src: local("${fontName}"),
    //           url("${fontPath}") format("${fontType}");
    //     }
    //     `,
    // );
  }

  connectedCallback() {
    this.render();
    const fontList: any = this.querySelector("select[ref='lists']");
    fontList.addEventListener("change", this.handleSelect.bind(this));
  }
}

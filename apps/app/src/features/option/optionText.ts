import { LitElement, PropertyValues, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { ensureFontFace } from "../font/fontFaces";
import { resolveTextStyle } from "../text/style";
import { setIn } from "../../utils/immutable";
import { rasterizeTextElements } from "../element/rasterizeText";

@customElement("option-text")
export class OptionText extends LitElement {
  elementId: string[];
  fontList: any[];

  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();
  align: "left" | "center" | "right";
  isBold: boolean;
  isItalic: boolean;

  @property()
  timeline = this.timelineState.timeline;

  @property()
  timelineCursor = this.timelineState.cursor;

  @property()
  isShow = false;
  updateOnce: any;
  selectedFont: string;

  constructor() {
    super();

    this.elementId = [];
    this.fontList = [];
    this.align = "left";
    this.isBold = false;
    this.isItalic = false;
    this.updateOnce = false;
    this.selectedFont = "notosanskr";
    this.insertPresetFontLists();
    this.insertFontLists();
    this.hide();
  }

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
      this.timelineCursor = state.cursor;
    });

    return this;
  }

  render() {
    const fontListTemplate: any = [];

    for (let index = 0; index < this.fontList.length; index++) {
      const font = this.fontList[index];

      fontListTemplate.push(html`
        <li>
          <a
            class="dropdown-item dropdown-item-sm ${this.selectedFont ==
            font.name
              ? "bg-primary"
              : ""}"
            style="font-family: '${font.name}'"
            @click=${() => this.handleChangeTextFont(font.value, font.name)}
            >${font.name}</a
          >
        </li>
      `);
    }

    return html`
      <span class="text-light ${this.elementId.length > 1 ? "" : "d-none"}"
        >${this.elementId.length} selected</span
      >

      <default-transform
        .elementId=${this.elementId}
        .timeline=${this.timeline}
        .timelineCursor=${this.timelineCursor}
        .timelineState=${this.timelineState}
        .isShow=${this.isShow}
      ></default-transform>

      <div class="mb-2">
        <label class="form-label text-light">Text</label>
        <input
          @click=${this.handleClickTextForm}
          @input=${this.handleChangeText}
          @change=${this.handleChangeText}
          aria-event="text"
          type="text"
          class="form-control bg-default text-light"
          value="TITLE"
        />
      </div>

      <div class="mb-2">
        <label class="form-label text-light">Color</label>
        <input
          @input=${this.handleChangeTextColor}
          aria-event="font-color"
          type="color"
          class="form-control bg-default form-control-color"
          value="#ffffff"
          title="Choose your color"
        />
      </div>

      <div class="mb-2">
        <label class="form-label text-light">Font Size</label>
        <input
          @change=${this.handleChangeTextSize}
          aria-event="font-size"
          type="number"
          class="form-control bg-default text-light"
          value="52"
        />
      </div>

      <div class="mb-2">
        <label class="form-label text-light">Letter Spacing</label>
        <input
          @change=${this.handleChangeLetterSpacing}
          aria-event="letter-spacing"
          type="number"
          class="form-control bg-default text-light"
          value="0"
        />
      </div>

      <div class="mb-2">
        <label class="form-label text-light">Font</label>

        <div class="dropdown ">
          <button
            class="btn btn-dark btn-sm dropdown-toggle"
            type="button"
            data-bs-toggle="dropdown"
            data-bs-display="static"
            aria-expanded="false"
          >
            Select Font
          </button>
          <ul
            class="dropdown-menu"
            style="    height: 160px;
    overflow: scroll; "
          >
            <li>
              <a
                class="dropdown-item dropdown-item-sm ${this.selectedFont ==
                "notosanskr"
                  ? "bg-primary"
                  : ""}"
                @click=${() =>
                  this.handleChangeTextFont("default", "notosanskr")}
                >Pretendard</a
              >
            </li>
            ${fontListTemplate}
          </ul>
        </div>
      </div>

      <label class="form-label text-light">Font Options</label>

      <div class="mb-2">
        <div class="btn-group" role="group" aria-label="Basic example">
          <button
            type="button"
            class="btn btn-sm ${this.isBold
              ? "btn-primary"
              : "btn-default"}  text-light"
            @click=${this.handleClickEnableBold}
          >
            <span class="material-symbols-outlined icon-sm"> format_bold </span>
          </button>
          <button
            type="button"
            class="btn btn-sm ${this.isItalic
              ? "btn-primary"
              : "btn-default"} text-light"
            @click=${this.handleClickEnableItalic}
          >
            <span class="material-symbols-outlined icon-sm">
              format_italic
            </span>
          </button>
        </div>
      </div>

      <div class="mb-2">
        <div class="btn-group" role="group" aria-label="Basic example">
          <button
            type="button"
            class="btn btn-sm ${this.align == "left"
              ? "btn-primary"
              : "btn-default"} text-light"
            @click=${() => this.handleClickAlign("left")}
          >
            <span class="material-symbols-outlined icon-sm">
              format_align_left
            </span>
          </button>
          <button
            type="button"
            class="btn btn-sm ${this.align == "center"
              ? "btn-primary"
              : "btn-default"} text-light"
            @click=${() => this.handleClickAlign("center")}
          >
            <span class="material-symbols-outlined icon-sm">
              format_align_center
            </span>
          </button>
          <button
            type="button"
            class="btn btn-sm ${this.align == "right"
              ? "btn-primary"
              : "btn-default"} text-light"
            @click=${() => this.handleClickAlign("right")}
          >
            <span class="material-symbols-outlined icon-sm">
              format_align_right
            </span>
          </button>
        </div>
      </div>

      ${this.renderEffects()}
    `;
  }

  /**
   * The style of the first selected clip, with every default filled in.
   *
   * These sections read straight from the store on each render rather than
   * mirroring values onto instance fields the way the older controls above do.
   * `timeline` is a `@property`, and the subscription in `createRenderRoot`
   * reassigns it on every store change — so undo, a preset click, or an agent
   * edit all refresh these inputs, which is exactly what `resetValue()` fails
   * to do for the controls it manages.
   */
  private get textStyle() {
    const element = this.timeline?.[this.elementId[0]];
    return resolveTextStyle(
      element?.filetype === "text"
        ? element
        : ({ options: {}, background: {} } as any),
    );
  }

  /**
   * Write style paths to **every** selected text clip, as one undo step.
   *
   * The older handlers on this panel take one of two wrong routes: most write
   * `this.elementId[0]` and silently drop the rest of the selection, and all of
   * them use `updateTimeline`, which records no history at all. Everything
   * below goes through here instead.
   */
  private commitStyle(writes: Array<{ path: string[]; value: unknown }>) {
    useTimelineStore.getState().withCheckpoint((doc) => {
      let next = doc;
      for (const id of this.elementId) {
        if (doc.elements[id]?.filetype !== "text") {
          continue;
        }
        for (const write of writes) {
          next = setIn(next, ["elements", id, ...write.path], write.value);
        }
      }
      // Nothing applicable in the selection: hand the document back by
      // identity so `withCheckpoint` records no step.
      return next;
    });
  }

  private set(path: string[], value: unknown) {
    this.commitStyle([{ path, value }]);
  }

  /** A labelled number input bound to one style path. */
  private numberRow(
    label: string,
    path: string[],
    value: number,
    { min = 0, max = 500, step = 1 }: { min?: number; max?: number; step?: number } = {},
  ) {
    return html`<div class="col-6 mb-2">
      <label class="form-label text-light small">${label}</label>
      <input
        type="number"
        class="form-control form-control-sm bg-default text-light"
        min=${min}
        max=${max}
        step=${step}
        .value=${String(value)}
        @change=${(e: Event) =>
          this.set(path, Number((e.target as HTMLInputElement).value))}
      />
    </div>`;
  }

  private colorRow(label: string, path: string[], value: string) {
    return html`<div class="col-6 mb-2">
      <label class="form-label text-light small">${label}</label>
      <input
        type="color"
        class="form-control form-control-sm bg-default form-control-color"
        .value=${value}
        @input=${(e: Event) =>
          this.set(path, (e.target as HTMLInputElement).value)}
      />
    </div>`;
  }

  private toggle(label: string, path: string[], enabled: boolean) {
    return html`<button
      type="button"
      class="btn btn-sm mb-2 w-100 ${enabled
        ? "btn-primary"
        : "btn-default"} text-light"
      @click=${() => this.set(path, !enabled)}
    >
      ${enabled ? "Disable" : "Enable"} ${label}
    </button>`;
  }

  private renderEffects() {
    const style = this.textStyle;

    return html`
      <hr class="border-secondary" />

      <div class="mb-2">
        <label class="form-label text-light">Text Opacity</label>
        <input
          type="range"
          class="form-range"
          min="0"
          max="100"
          .value=${String(style.textOpacity)}
          @change=${(e: Event) =>
            this.set(["textOpacity"], Number((e.target as HTMLInputElement).value))}
        />
      </div>

      <div class="mb-2">
        <label class="form-label text-light">Letter Case</label>
        <select
          class="form-select form-select-sm bg-default text-light"
          @change=${(e: Event) =>
            this.set(
              ["options", "textTransform"],
              (e.target as HTMLSelectElement).value,
            )}
        >
          ${["none", "uppercase", "lowercase"].map(
            (value) =>
              html`<option
                value=${value}
                ?selected=${style.textTransform === value}
              >
                ${value}
              </option>`,
          )}
        </select>
      </div>

      <div class="mb-2">
        <label class="form-label text-light">Fill</label>
        <select
          class="form-select form-select-sm bg-default text-light"
          @change=${(e: Event) => this.handleChangeFillType(e)}
        >
          <option value="solid" ?selected=${style.fill.type === "solid"}>
            solid
          </option>
          <option value="gradient" ?selected=${style.fill.type === "gradient"}>
            gradient
          </option>
        </select>
      </div>

      ${style.fill.type === "gradient"
        ? html`<div class="row">
            ${this.colorRow("From", ["fill", "from"], style.fill.from)}
            ${this.colorRow("To", ["fill", "to"], style.fill.to)}
            ${this.numberRow("Angle", ["fill", "angle"], style.fill.angle, {
              min: 0,
              max: 360,
            })}
          </div>`
        : ""}

      ${this.toggle("Outline", ["options", "outline", "enable"], style.outline.enable)}
      ${style.outline.enable
        ? html`<div class="row">
            ${this.numberRow("Size", ["options", "outline", "size"], style.outline.size, { max: 200 })}
            ${this.numberRow("Opacity", ["options", "outline", "opacity"], style.outline.opacity, { max: 100 })}
            ${this.colorRow("Color", ["options", "outline", "color"], style.outline.color)}
          </div>`
        : ""}

      ${this.toggle("Shadow", ["options", "shadow", "enable"], style.shadow.enable)}
      ${style.shadow.enable
        ? html`<div class="row">
            ${this.numberRow("Offset X", ["options", "shadow", "offsetX"], style.shadow.offsetX, { min: -500 })}
            ${this.numberRow("Offset Y", ["options", "shadow", "offsetY"], style.shadow.offsetY, { min: -500 })}
            ${this.numberRow("Blur", ["options", "shadow", "blur"], style.shadow.blur)}
            ${this.numberRow("Opacity", ["options", "shadow", "opacity"], style.shadow.opacity, { max: 100 })}
            ${this.colorRow("Color", ["options", "shadow", "color"], style.shadow.color)}
          </div>`
        : ""}

      ${this.toggle("Glow", ["options", "glow", "enable"], style.glow.enable)}
      ${style.glow.enable
        ? html`<div class="row">
            ${this.numberRow("Size", ["options", "glow", "size"], style.glow.size)}
            ${this.numberRow("Opacity", ["options", "glow", "opacity"], style.glow.opacity, { max: 100 })}
            ${this.colorRow("Color", ["options", "glow", "color"], style.glow.color)}
          </div>`
        : ""}

      ${this.toggle("Background", ["background", "enable"], style.background.enable)}
      ${style.background.enable
        ? html`<div class="row">
            ${this.numberRow("Opacity", ["background", "opacity"], style.background.opacity, { max: 100 })}
            ${this.numberRow("Padding", ["background", "padding"], style.background.padding)}
            ${this.numberRow("Radius", ["background", "radius"], style.background.radius)}
            ${this.colorRow("Color", ["background", "color"], style.background.color)}
          </div>`
        : ""}

      <hr class="border-secondary" />

      <button
        type="button"
        class="btn btn-sm btn-default text-light w-100 mb-2"
        title="Bake this text into an image clip with the same position and timing"
        @click=${this.handleClickRasterize}
      >
        Rasterize to Image
      </button>
    `;
  }

  /**
   * Switching fill mode writes the whole `fill` object, not just its `type`.
   *
   * `TextFill` is a union: a `{ type: "gradient" }` with no `from`/`to` is not
   * a value the renderer can draw, so the colours have to arrive in the same
   * edit that flips the mode.
   */
  handleChangeFillType(event: Event) {
    const type = (event.target as HTMLSelectElement).value;
    if (type !== "gradient") {
      this.set(["fill"], { type: "solid" });
      return;
    }

    const current = this.textStyle.fill;
    this.set(["fill"], {
      type: "gradient",
      from: current.type === "gradient" ? current.from : "#ffffff",
      to: current.type === "gradient" ? current.to : "#7c5cff",
      angle: current.type === "gradient" ? current.angle : 90,
    });
  }

  async handleClickRasterize() {
    const cursor = useTimelineStore.getState().cursor ?? 0;
    const results = await rasterizeTextElements([...this.elementId], cursor);

    const failed = results.filter((result) => !result.ok);
    if (failed.length > 0) {
      document.querySelector("toast-box")?.showToast({
        message: `Could not rasterize ${failed.length} clip(s)`,
        delay: "4000",
      });
    }
  }

  hide() {
    this.classList.add("d-none");
    this.isShow = false;
  }

  show() {
    this.classList.remove("d-none");
    this.isShow = true;
  }

  setElementId({ elementId }) {
    this.elementId = [elementId];

    this.resetValue();
  }

  setElementIds({ elementIds }) {
    this.elementId = elementIds;

    this.resetValue();

    this.requestUpdate();
  }

  /**
   * The twenty bundled Google Fonts, ahead of the system fonts in the dropdown.
   *
   * Without this the presets in the "Text" panel would be a one-way door: a
   * user could add a clip in Bebas Neue but not switch an existing one to it,
   * because this list only ever showed what `get-system-fonts` found installed.
   */
  insertPresetFontLists() {
    window.electronAPI.req.font.getPresetFontLists().then((result: any) => {
      for (const font of result?.fonts ?? []) {
        ensureFontFace(font);
        this.fontList.unshift({
          index: this.fontList.length + 1,
          value: font.path,
          name: font.name,
        });
      }
      this.requestUpdate();
    });
  }

  insertFontLists() {
    window.electronAPI.req.font.getLists().then((result) => {
      if (result.status == 0) {
        return 0;
      }

      for (let index = 0; index < result.fonts.length; index++) {
        const font = result.fonts[index];
        this.fontList.push({
          index: index + 1,
          value: font.path,
          name: font.name,
        });

        if (!this.updateOnce) {
          for (let index = 0; index < this.fontList.length; index++) {
            const font = this.fontList[index];

            const type = font.value
              .split("/")
              [font.value.split("/").length - 1].split(".")[1];

            console.log();

            document.querySelector("#fontStyles").insertAdjacentHTML(
              "beforeend",
              `
            @font-face {
                font-family: "${font.name}";
                src: local("${font.name}"),
                  url("${font.value}") format("${type}");
            }
            `,
            );
          }
          this.updateOnce = true;
        }

        this.requestUpdate();
      }
    });
  }

  resetValue() {
    const timeline = document.querySelector("element-timeline").timeline;
    const fontColor: any = this.querySelector("input[aria-event='font-color'");
    const fontSize: any = this.querySelector("input[aria-event='font-size'");
    const text: any = this.querySelector("input[aria-event='text'");
    const letterSpacing: any = this.querySelector(
      "input[aria-event='letter-spacing'",
    );

    fontColor.value = timeline[this.elementId[0]].textcolor;
    fontSize.value = timeline[this.elementId[0]].fontsize;
    text.value = timeline[this.elementId[0]].text;
    letterSpacing.value = timeline[this.elementId[0]].letterSpacing;
    this.align = timeline[this.elementId[0]].options.align;
    this.isBold = timeline[this.elementId[0]].options.isBold;
    this.isItalic = timeline[this.elementId[0]].options.isItalic;
    this.selectedFont = timeline[this.elementId[0]].fontname;
  }

  handleClickAlign(align) {
    this.timelineState.updateTimeline(
      this.elementId[0],
      ["options", "align"],
      align,
    );

    this.align = align;
    this.requestUpdate();
  }

  handleClickEnableBold() {
    const state = useTimelineStore.getState();
    const textElement = state.timeline[this.elementId[0]];
    if (textElement.filetype !== "text") {
      return;
    }

    for (let index = 0; index < this.elementId.length; index++) {
      const element = this.elementId[index];
      this.isBold = !textElement.options.isBold;

      this.timelineState.updateTimeline(
        element,
        ["options", "isBold"],
        !textElement.options.isBold,
      );
    }

    this.requestUpdate();
  }

  handleClickEnableItalic() {
    const state = useTimelineStore.getState();
    const textElement = state.timeline[this.elementId[0]];
    if (textElement.filetype !== "text") {
      return;
    }
    this.isItalic = !textElement.options?.isItalic;

    this.timelineState.updateTimeline(
      this.elementId[0],
      ["options", "isItalic"],
      !textElement.options?.isItalic,
    );

    this.requestUpdate();
  }

  handleClickTextForm() {
    this.timelineState.setCursorType("text");
  }

  handleChangeLetterSpacing(e) {
    const letterSpacing: any = this.querySelector(
      "input[aria-event='letter-spacing'",
    );

    for (let index = 0; index < this.elementId.length; index++) {
      const element = this.elementId[index];
      this.timelineState.updateTimeline(
        element,
        ["letterSpacing"],
        parseInt(letterSpacing.value),
      );
    }
  }

  handleChangeTextColor() {
    const elementControl = document.querySelector("element-control");
    const fontColor: any = this.querySelector("input[aria-event='font-color'");
    const color = fontColor.value;
    for (let index = 0; index < this.elementId.length; index++) {
      const element = this.elementId[index];
      elementControl.changeTextColor({ elementId: element, color: color });
    }
  }

  handleChangeText(e) {
    // e.preventDefault();
    // e.stopPropagation();

    const elementControl = document.querySelector("element-control");
    const text: any = this.querySelector("input[aria-event='text'");

    const textValue = text.value;
    elementControl.changeTextValue({
      elementId: this.elementId[0],
      value: textValue,
    });
  }

  handleChangeTextSize() {
    const elementControl = document.querySelector("element-control");
    const fontSize: any = this.querySelector("input[aria-event='font-size'");
    const size = fontSize.value;
    for (let index = 0; index < this.elementId.length; index++) {
      const element = this.elementId[index];
      elementControl.changeTextSize({ elementId: element, size: size });
    }
  }

  handleChangeTextFont(value, name) {
    const elementControl = document.querySelector("element-control");

    const selectedText = name;
    this.selectedFont = name;

    const type = value.split("/")[value.split("/").length - 1].split(".")[1];

    elementControl.changeTextFont({
      elementId: this.elementId[0],
      fontPath: value,
      fontType: type,
      fontName: selectedText,
    });
  }
}

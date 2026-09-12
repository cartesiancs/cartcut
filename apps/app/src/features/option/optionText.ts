import { LitElement, PropertyValues, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { ensureFontFace } from "../font/fontFaces";
import { resolveTextStyle } from "../text/style";
import { setIn } from "../../utils/immutable";
import { rasterizeTextElements } from "../element/rasterizeText";
import { affectsTextBlock, withFittedTextHeights } from "../element/textFit";
import { DEFAULT_LINE_HEIGHT, coerceLineHeight } from "../text/metrics";
import { applyMenuPlacement } from "../menu/menuPlacement";
import type { FontEntry } from "../font/fontFaces";
import type { FontFamily } from "../font/fontWeight";
import {
  DEFAULT_FONT_WEIGHT,
  FONT_WEIGHTS,
  coerceFontWeight,
  elementFontWeight,
  faceFor,
  groupFontFamilies,
  labelForWeight,
  parseFaceName,
} from "../font/fontWeight";
import "./animationPresetBrowser";
import "./controlBlendMode";
import "./optionLutSection";
import "./optionAdjustSection";
import "./optionMaskSection";
import "./optionTabBar";
import "./optionTextRevealSection";
import type { OptionTab } from "./optionTabBar";
import { beginInputScrub, scrubOn } from "../input/inputScrub";
import { sweepSpec } from "../input/numberScrub";

// Font size and letter spacing are whole pixels — both handlers read the field
// back as an integer. Line spacing is a multiple of the size, so it moves in
// twentieths across the same 0.5..4 band the field declares.
const SCRUB_FONT_SIZE = scrubOn({ sensitivity: 0.5, step: 1, min: 1, decimals: 0 });
const SCRUB_LINE_HEIGHT = scrubOn({
  sensitivity: 0.01,
  step: 0.05,
  min: 0.5,
  max: 4,
  decimals: 2,
});
const SCRUB_LETTER_SPACING = scrubOn({ sensitivity: 0.25, step: 1, decimals: 0 });

/**
 * The bundled default font: the name it is stored under, and the name it is
 * shown under. They differ — the file has been Pretendard since long before
 * anyone renamed the identifier — and both the list item and the button label
 * need the pair, so it is stated once here rather than spelled out twice.
 *
 * "(Built-in)" is not decoration. Now that the picker lists *families*, a
 * machine with Pretendard installed has a real `Pretendard` family of its own,
 * and the two would otherwise be two rows with one name — one of which ships
 * with the app and is the last resort in every `ctx.font` stack the renderer
 * builds, and one of which is on this machine only.
 */
const DEFAULT_FONT_NAME = "notosanskr";
const DEFAULT_FONT_LABEL = "Pretendard (Built-in)";

/** How tall the scrolling name list may get before it scrolls, in px. */
const FONT_LIST_MAX_PX = 360;

/**
 * How short it may be squeezed when the window cannot hold that.
 *
 * A list clamped to the space available can end up a few pixels tall next to a
 * button near the window edge, which is a menu that opened and shows nothing.
 * Below this it is better to overhang slightly than to vanish.
 */
const FONT_LIST_MIN_PX = 120;

/** The narrowest the menu gets, whatever the option column has been dragged to. */
const FONT_MENU_MIN_WIDTH_PX = 220;

/** The bundled default, as an entry in the same list every other font is in. */
const DEFAULT_FONT_ENTRY: FontEntry = {
  path: "default",
  name: DEFAULT_FONT_NAME,
  type: "otf",
};

@customElement("option-text")
export class OptionText extends LitElement {
  elementId: string[];

  /**
   * Every font file the machine has, flat — one entry per *face*, which is
   * what `electron/lib/font.ts` returns and what `fontname` has always held.
   * `fontFamilies()` folds it into the families the picker actually shows.
   */
  fontList: FontEntry[];

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

  /**
   * Which pane is showing. Component state, not document state: it is where the
   * user is looking, not something about the clip.
   */
  @property()
  tab: OptionTab = "media";
  selectedFont: string;

  /**
   * The weight of the selected clip, as the panel last read it.
   *
   * Held alongside `selectedFont` and for the same reason: `resetValue` fills
   * both from the document when the selection changes, and the two together
   * are what the family and weight controls show back.
   */
  selectedWeight = DEFAULT_FONT_WEIGHT;

  /**
   * `groupFontFamilies` over `fontList`, kept until the list grows.
   *
   * The grouping walks four hundred filenames, and the store subscription in
   * `createRenderRoot` re-renders this panel on every cursor tick — so doing it
   * in `render` would run it sixty times a second during playback. The list is
   * append-only and built once at startup, so its length is a sufficient key.
   */
  private familiesCache: { size: number; families: FontFamily[] } | null = null;

  /**
   * What has been typed into the font dropdown's search box.
   *
   * A `@property` rather than a plain field: the store subscription in
   * `createRenderRoot` re-renders this panel on every document change, and the
   * filtered list has to survive that. The field is bound to the input with
   * `.value`, so lit leaves the DOM node — and the caret — alone whenever the
   * two already agree, which is every render but the one the keystroke caused.
   */
  @property()
  fontQuery = "";

  /**
   * Whether the font menu is open.
   *
   * This control does not use Bootstrap's dropdown JS, which is why the state
   * has to live here. See `placeFontMenu` for what it buys.
   */
  @property()
  fontMenuOpen = false;

  /**
   * The text last written into history, and the only thing that decides whether
   * there is anything to commit. Not a `@property`: it tracks the *field*, not
   * the document, and re-rendering must not disturb it.
   */
  private committedText: string | null = null;

  constructor() {
    super();

    this.elementId = [];
    this.fontList = [DEFAULT_FONT_ENTRY];
    this.align = "left";
    this.isBold = false;
    this.isItalic = false;
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
    // Families, not files. A machine with Aktiv Grotesk installed has eleven
    // font *files* for it, and listing those as eleven separate fonts is what
    // made a weight control impossible — see `font/fontWeight.ts`.
    const families = this.fontFamilies();
    const current = this.currentFamily();
    const fontListTemplate: any = [];

    for (const family of families) {
      if (!this.matchesFontQuery(this.familyLabel(family))) {
        continue;
      }

      // Previewed in the family's own regular face rather than in whichever
      // weight is selected: the list is a comparison, and one row drawn Black
      // among forty drawn Regular reads as a different typeface instead of as
      // the same one at a different weight.
      const preview = faceFor(family, DEFAULT_FONT_WEIGHT, false);

      fontListTemplate.push(html`
        <li>
          <a
            class="dropdown-item dropdown-item-sm text-truncate ${current?.family ===
            family.family
              ? "bg-primary"
              : ""}"
            style=${preview == null ? "" : `font-family: '${preview.entry.name}'`}
            @click=${() => this.handleChangeFontFamily(family)}
            >${this.familyLabel(family)}</a
          >
        </li>
      `);
    }

    return html`
      <option-tab-bar
        .active=${this.tab}
        @tab-change=${(e: CustomEvent<OptionTab>) => {
          this.tab = e.detail;
        }}
      ></option-tab-bar>

      <!-- Every pane stays mounted; only one is shown. See optionTabBar.ts -->
      <div class=${this.tab === "adjust" ? "" : "d-none"}>
        <option-adjust-section
          .elementIds=${[this.elementId]}
        ></option-adjust-section>
      </div>

      <div class=${this.tab === "mask" ? "" : "d-none"}>
        <option-mask-section
          .elementIds=${this.elementId}
        ></option-mask-section>
      </div>

      <div class=${this.tab === "animation" ? "" : "d-none"}>
        <!-- A reveal is one keyframe track on one scalar, so it belongs with
             the other animation, above the presets that cannot write it. -->
        <option-text-reveal-section
          .elementIds=${this.elementId}
        ></option-text-reveal-section>
        <animation-preset-browser
          .elementIds=${this.elementId}
        ></animation-preset-browser>
      </div>

      <div class=${this.tab === "media" ? "" : "d-none"}>
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

      <blend-mode
        .elementId=${this.elementId}
        .isShow=${this.isShow}
      ></blend-mode>

      <!--
        Next to the blend mode, because the two are the same question asked
        twice: how this clip's picture is changed before it meets the scene,
        and how it meets it. Picking *which* filter happens in the Filter tab
        against thumbnails; what belongs here is how strongly it applies.
      -->
      <option-lut-section
        .elementId=${this.elementId}
      ></option-lut-section>

      <!--
        A textarea, not an input: a title that breaks over two lines is a thing
        the renderer can draw (text/lines.ts), and a single-line field cannot
        even hold the string — assigning one strips the break, and the next
        keystroke writes the flattened version back over the element.

        Deliberately not value-bound. The store subscription in
        createRenderRoot re-renders this panel on every change, including the
        ones this field itself makes, so a bound value would put the caret back
        at the end on every keystroke. resetValue() fills it in instead.
      -->
      <div class="mb-2">
        <label class="form-label text-light">Text</label>
        <textarea
          @click=${this.handleClickTextForm}
          @input=${this.handleInputText}
          @change=${this.handleCommitText}
          aria-event="text"
          rows="3"
          class="form-control bg-default text-light"
          style="resize: vertical; min-height: 64px;"
        ></textarea>
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
          @mousedown=${SCRUB_FONT_SIZE}
          aria-event="font-size"
          type="number"
          class="form-control bg-default text-light scrub-number"
          value="52"
        />
      </div>

      <!--
        Leading, as a multiple of the font size. It lives next to Font Size
        because that is what it is measured in, and because between them they
        are the whole of a line's vertical rhythm.

        This used to be the Size panel's height field by accident: height was
        the line advance, so growing a text box spread its lines instead of
        resizing it. Now the box follows the text and this is where the spacing
        is asked for.
      -->
      <div class="mb-2">
        <label class="form-label text-light">Line Spacing</label>
        <input
          @change=${this.handleChangeLineHeight}
          @mousedown=${SCRUB_LINE_HEIGHT}
          aria-event="line-height"
          type="number"
          min="0.5"
          max="4"
          step="0.1"
          class="form-control bg-default text-light scrub-number"
          .value=${String(this.textStyle.lineHeight)}
        />
      </div>

      <div class="mb-2">
        <label class="form-label text-light">Letter Spacing</label>
        <input
          @change=${this.handleChangeLetterSpacing}
          @mousedown=${SCRUB_LETTER_SPACING}
          aria-event="letter-spacing"
          type="number"
          class="form-control bg-default text-light scrub-number"
          value="0"
        />
      </div>

      <!--
        The button says which font the clip is in, not what the control does.
        A picker that reads "Select Font" whatever is selected makes the panel
        the one place in the app that cannot answer the question it is for —
        every other row here (Font Size, Color, Line Spacing) shows its value.
      -->
      <div class="mb-2">
        <label class="form-label text-light">Font</label>

        <div class="dropdown">
          <button
            aria-event="font-toggle"
            class="btn btn-dark btn-sm dropdown-toggle w-100 d-flex align-items-center text-start"
            type="button"
            aria-expanded=${this.fontMenuOpen}
            title=${this.selectedFontLabel}
            @click=${this.handleToggleFontMenu}
          >
            <!--
              A flex row, so a long font name ellipsises against the caret
              instead of pushing it out of an overflow-hidden button.
            -->
            <span class="flex-grow-1 text-truncate"
              >${this.selectedFontLabel}</span
            >
          </button>
          <div
            aria-event="font-menu"
            class="dropdown-menu p-0 ${this.fontMenuOpen ? "show" : ""}"
            style="z-index: 6000;"
          >
            <!--
              Outside the scrolling list, so it stays put while the names move
              under it. placeFontMenu gives the list its height; the frame gets
              none, or the search box would scroll away with them.
            -->
            <div class="p-2">
              <input
                type="text"
                aria-event="font-search"
                class="form-control form-control-sm bg-default text-light"
                placeholder="Search fonts"
                .value=${this.fontQuery}
                @input=${this.handleSearchFont}
              />
            </div>
            <ul
              aria-event="font-list"
              class="list-unstyled mb-0"
              style="overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;"
            >
              ${fontListTemplate.length === 0
                ? html`<li>
                    <span class="dropdown-item-text text-secondary"
                      >No fonts found</span
                    >
                  </li>`
                : fontListTemplate}
            </ul>
          </div>
        </div>
      </div>

      <!--
        Only the weights this family actually ships. A native select rather
        than another overlay menu: the list is at most nine rows and never
        needs a search, and a select is the one control that already says
        "these are all the choices" without being opened.
      -->
      <div class="mb-2">
        <label class="form-label text-light">Weight</label>
        <select
          aria-event="font-weight"
          class="form-select form-control bg-default text-light"
          ?disabled=${this.availableWeights().length < 2}
          @change=${this.handleChangeFontWeight}
        >
          <!--
            The selection is a property on the option, not a value binding on
            the select and not the selected attribute. Lit commits an element's
            own bindings before its children, so a value binding would be
            assigned while the select is still empty and silently do nothing;
            and once anyone has used the control, its dirty flag makes the
            attribute stop moving the visible selection.
          -->
          ${this.availableWeights().map(
            (weight) => html`
              <option value=${weight} .selected=${weight === this.selectedWeight}>
                ${labelForWeight(weight)}
              </option>
            `,
          )}
        </select>
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
      </div>
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
      // The box follows the type — but only for the writes that change how tall
      // the block is. Alignment, colour and every effect repaint the same shape,
      // and re-fitting on those would throw away a height the user typed.
      // Folding the fit in here means it shares this edit's undo step.
      //
      // Nothing applicable in the selection: hand the document back by
      // identity so `withCheckpoint` records no step.
      return affectsTextBlock(writes.map((write) => write.path))
        ? withFittedTextHeights(next, this.elementId)
        : next;
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
        class="form-control form-control-sm bg-default text-light scrub-number"
        min=${min}
        max=${max}
        step=${step}
        .value=${String(value)}
        @mousedown=${(e: MouseEvent) =>
          beginInputScrub(e, sweepSpec(min, max, step))}
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
            ${this.numberRow("Blur", ["background", "blur"], style.background.blur)}
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
    // The menu is `position: fixed`, so it is not hidden by the panel being
    // hidden — it would go on floating over the editor with nothing under it.
    this.closeFontMenu();
  }

  show() {
    this.classList.remove("d-none");
    this.isShow = true;
  }

  setElementId({ elementId }) {
    // Before the selection moves off it: clicking another clip does not blur
    // the field in a way that fires `change`, so without this the typing that
    // was still uncommitted would live on in the store with no undo step of
    // its own.
    this.handleCommitText();

    this.elementId = [elementId];

    this.resetValue();
  }

  setElementIds({ elementIds }) {
    this.handleCommitText();

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
        this.fontList.push(font);
      }
      this.requestUpdate();
    });
  }

  /**
   * Every system font, registered as it is listed.
   *
   * The registration used to be a loop nested inside this one, guarded by
   * `updateOnce` — which it set on its *first* pass, so it injected an
   * `@font-face` for the presets and for the first system font and for nothing
   * else. Fonts whose CSS family happens to match an installed family name
   * ("Arial", "Georgia") resolved anyway, straight out of the system, which is
   * what hid it; `AktivGrotesk-Bold` is not a family name any OS knows and
   * drew in the fallback with nothing to say so.
   *
   * It matters more now than it did: the picker previews each row in its own
   * face, and a weight is chosen by naming a *file*, so every face has to be
   * reachable by the name the element stores.
   */
  insertFontLists() {
    window.electronAPI.req.font.getLists().then((result) => {
      if (result.status == 0) {
        return 0;
      }

      for (const font of result.fonts) {
        ensureFontFace(font);
        this.fontList.push(font);
      }

      this.requestUpdate();
    });
  }

  resetValue() {
    const timeline = document.querySelector("element-timeline").timeline;
    const fontColor: any = this.querySelector("input[aria-event='font-color'");
    const fontSize: any = this.querySelector("input[aria-event='font-size'");
    const text = this.textField();
    const letterSpacing: any = this.querySelector(
      "input[aria-event='letter-spacing'",
    );

    fontColor.value = timeline[this.elementId[0]].textcolor;
    fontSize.value = timeline[this.elementId[0]].fontsize;
    if (text != null) {
      text.value = timeline[this.elementId[0]].text ?? "";
      // The baseline `handleCommitText` compares against, so simply focusing
      // and leaving the field records nothing.
      this.committedText = text.value;
    }
    letterSpacing.value = timeline[this.elementId[0]].letterSpacing;
    this.align = timeline[this.elementId[0]].options.align;
    this.isBold = timeline[this.elementId[0]].options.isBold;
    this.isItalic = timeline[this.elementId[0]].options.isItalic;
    this.selectedFont = timeline[this.elementId[0]].fontname;
    this.selectedWeight = elementFontWeight(
      this.selectedFont,
      timeline[this.elementId[0]].fontweight,
    );
  }

  /**
   * Leading, as a multiple of the font size.
   *
   * `coerceLineHeight` runs here rather than at read time so an unusable value
   * — an emptied field arrives as `""` -> `NaN` — is never what gets stored.
   */
  handleChangeLineHeight(event: Event) {
    const value = coerceLineHeight((event.target as HTMLInputElement).value);
    // The default is stored as absence, the same rule `blend` and `lut` follow:
    // a project set back to normal leading saves byte-identically to one that
    // never had the field. `JSON.stringify` drops an `undefined` value, so the
    // key does not reach `timeline.json` at all.
    this.set(
      ["options", "lineHeight"],
      value === DEFAULT_LINE_HEIGHT ? undefined : value,
    );
    this.requestUpdate();
  }

  /*
   * The four below used to write through `updateTimeline`, which records no
   * history at all — so bolding a caption, or aligning it, was not undoable and
   * most of them silently dropped everything but the first clip in the
   * selection. They go through `commitStyle` now, which writes the whole
   * selection as one checkpoint and re-fits the boxes: all four change how tall
   * the wrapped block is.
   */

  handleClickAlign(align) {
    this.set(["options", "align"], align);

    this.align = align;
    this.requestUpdate();
  }

  handleClickEnableBold() {
    const textElement = useTimelineStore.getState().timeline[this.elementId[0]];
    if (textElement?.filetype !== "text") {
      return;
    }

    // The first clip's state decides the direction, so a mixed selection lands
    // all on the same value rather than each flipping its own way.
    this.isBold = !textElement.options.isBold;
    this.set(["options", "isBold"], this.isBold);

    this.requestUpdate();
  }

  handleClickEnableItalic() {
    const textElement = useTimelineStore.getState().timeline[this.elementId[0]];
    if (textElement?.filetype !== "text") {
      return;
    }

    this.isItalic = !textElement.options?.isItalic;
    this.set(["options", "isItalic"], this.isItalic);

    this.requestUpdate();
  }

  handleClickTextForm() {
    this.timelineState.setCursorType("text");
  }

  handleChangeLetterSpacing() {
    const letterSpacing: any = this.querySelector(
      "input[aria-event='letter-spacing']",
    );

    const value = parseInt(letterSpacing.value, 10);
    if (!Number.isFinite(value)) {
      return;
    }

    // Wider tracking makes lines wrap sooner, so this changes the block height
    // too — `commitStyle` re-fits.
    this.set(["letterSpacing"], value);
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

  /** The text field itself. Absent until the panel has rendered once. */
  private textField(): HTMLTextAreaElement | null {
    return this.querySelector("textarea[aria-event='text']");
  }

  /**
   * Typing: update the store so the preview follows, but record no history.
   *
   * This used to go straight to `changeTextValue`, which checkpoints — so every
   * keystroke was its own undo step. That was already awkward for a one-line
   * title and unusable for a textarea, where a paragraph is several hundred
   * steps to press Cmd+Z through.
   */
  handleInputText() {
    const elementId = this.elementId[0];
    const element = useTimelineStore.getState().timeline[elementId];
    if (element?.filetype !== "text") {
      return;
    }

    const field = this.textField();
    if (field == null) {
      return;
    }

    this.timelineState.updateTimeline(elementId, ["text"], field.value);
  }

  /**
   * Leaving the field: turn everything typed since arriving into one undo step.
   *
   * `handleInputText` has already put the final string in the store, so this
   * commit is really "make the current state a history entry" — undo then lands
   * on the snapshot from before the typing began, which is the whole point.
   *
   * The equality guard is load-bearing. `setIn` rebuilds the path whether or
   * not the value changed, so `withCheckpoint` would see a new document and
   * record an empty step for a field that was merely clicked into.
   */
  handleCommitText() {
    const elementId = this.elementId[0];
    if (elementId == null) {
      return;
    }

    const field = this.textField();
    if (field == null || field.value === this.committedText) {
      return;
    }

    this.committedText = field.value;

    const elementControl = document.querySelector("element-control");
    elementControl.changeTextValue({
      elementId,
      value: field.value,
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

  /**
   * Does this font's name survive the search box?
   *
   * Case-insensitive substring, deliberately not a fuzzy match: the list is
   * one flat column of names the user is reading off the screen, and a fuzzy
   * matcher's job — ranking distant candidates — has nothing to rank here.
   */
  private matchesFontQuery(name: string): boolean {
    const query = this.fontQuery.trim().toLowerCase();
    return query === "" || name.toLowerCase().includes(query);
  }

  handleSearchFont(event: Event) {
    this.fontQuery = (event.target as HTMLInputElement).value;
  }

  /**
   * Open or close the font menu.
   *
   * The filter is cleared on the way open rather than on the way closed: a
   * query left over from last time would show a filtered list with no visible
   * reason, and in the worst case an empty one.
   */
  handleToggleFontMenu() {
    this.fontMenuOpen = !this.fontMenuOpen;

    if (!this.fontMenuOpen) {
      return;
    }

    this.fontQuery = "";

    // A frame, so the caret lands after `updated` has shown and placed the
    // menu — focusing a `display: none` field does nothing at all.
    requestAnimationFrame(() => {
      this.querySelector<HTMLInputElement>(
        "input[aria-event='font-search']",
      )?.focus();
    });
  }

  closeFontMenu() {
    if (!this.fontMenuOpen) {
      return;
    }

    this.fontMenuOpen = false;
    this.fontQuery = "";
  }

  /**
   * Anything but a click on this control's own toggle or menu closes it.
   *
   * Registered for the life of the component rather than only while the menu
   * is open, which is what lets the toggle's own click be excluded here
   * instead of raced against: a listener added while that click is still
   * bubbling would receive it and shut the menu on the way up.
   */
  private readonly onDocumentPointerDown = (event: Event) => {
    if (!this.fontMenuOpen) {
      return;
    }

    const target = event.target as Element | null;
    if (
      target?.closest("[aria-event='font-toggle']") != null ||
      target?.closest("[aria-event='font-menu']") != null
    ) {
      return;
    }

    this.closeFontMenu();
  };

  /**
   * Escape closes the menu, and stops there.
   *
   * `elementTimelineCanvas` binds Escape on `window` to cancel the current
   * gesture, and `document` runs first — so without the `stopPropagation` one
   * Escape would both close this menu and cancel whatever the user was doing
   * in the timeline behind it.
   */
  private readonly onDocumentKeydown = (event: KeyboardEvent) => {
    if (!this.fontMenuOpen || event.key !== "Escape") {
      return;
    }

    event.stopPropagation();
    this.closeFontMenu();
    this.querySelector<HTMLElement>("button[aria-event='font-toggle']")?.focus();
  };

  /**
   * A fixed menu does not travel with the panel that scrolled under it, so it
   * is re-placed against the button it belongs to.
   *
   * Capture phase, because the option column scrolls rather than the document
   * and a scroll event does not bubble past the element that scrolled. That
   * reaches *every* scroller in the app, including the menu's own list — which
   * is why the first thing this does is let the list through. Closing on that
   * one made the menu shut the moment anyone scrolled the names, which is the
   * single thing a long list is for.
   */
  private readonly onAncestorScroll = (event: Event) => {
    if (!this.fontMenuOpen) {
      return;
    }

    const menu = this.querySelector("[aria-event='font-menu']");
    const target = event.target as Node | null;
    if (menu != null && target != null && menu.contains(target)) {
      return;
    }

    // Scrolled far enough that the button is out of its own column: there is
    // nothing left on screen for the menu to be attached to, and a menu
    // hanging off an anchor nobody can see is worse than one that closed.
    if (this.isFontAnchorClipped(target)) {
      this.closeFontMenu();
      return;
    }

    this.placeFontMenu();
  };

  /** Has the toggle been scrolled out of the box that `scroller` clips it to? */
  private isFontAnchorClipped(scroller: Node | null): boolean {
    const button = this.querySelector<HTMLElement>(
      "button[aria-event='font-toggle']",
    );

    // `document` scrolls too, and clips nothing — the viewport does, and a
    // button off the top of the window is the caller's problem, not this one's.
    if (button == null || !(scroller instanceof Element)) {
      return false;
    }

    const box = scroller.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    return rect.bottom <= box.top || rect.top >= box.bottom;
  }

  /** A resize moves the button and changes the room around it. */
  private readonly onWindowResize = () => {
    if (this.fontMenuOpen) {
      this.placeFontMenu();
    }
  };

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
    document.addEventListener("keydown", this.onDocumentKeydown);
    document.addEventListener("scroll", this.onAncestorScroll, true);
    window.addEventListener("resize", this.onWindowResize);
  }

  disconnectedCallback() {
    document.removeEventListener(
      "pointerdown",
      this.onDocumentPointerDown,
      true,
    );
    document.removeEventListener("keydown", this.onDocumentKeydown);
    document.removeEventListener("scroll", this.onAncestorScroll, true);
    window.removeEventListener("resize", this.onWindowResize);
    super.disconnectedCallback();
  }

  updated(changed: PropertyValues) {
    super.updated(changed);

    // Opening moves the menu and typing resizes it; scrolling and resizing are
    // handled by their own listeners, which know the menu did not have to
    // re-render to need moving. This guard is not tidiness — the store
    // subscription in `createRenderRoot` re-renders this panel on every cursor
    // tick, and `placeFontMenu` forces a synchronous layout four times over.
    if (
      this.fontMenuOpen &&
      (changed.has("fontMenuOpen") || changed.has("fontQuery"))
    ) {
      this.placeFontMenu();
    }
  }

  /**
   * Put the open menu on the viewport, clear of the panel it lives in.
   *
   * The option column is `overflow-y-scroll overflow-x-hidden`, so a menu
   * positioned inside it is clipped at the column's bottom edge — which for a
   * list this tall is most of it. `position: fixed` is what escapes that, and
   * it is only safe because no ancestor of this panel carries a `transform`,
   * `filter` or `backdrop-filter`; any of those would make the column the
   * containing block again and put the clipping straight back.
   *
   * `applyMenuPlacement` is the same module the right-click menus use, and it
   * is what keeps the list on screen: `html, body { overflow: hidden }` means
   * anything pushed past the bottom of the window is not merely off-screen but
   * unreachable, since there is no scrollbar and, in Electron, no browser
   * chrome either.
   */
  private placeFontMenu() {
    const button = this.querySelector<HTMLElement>(
      "button[aria-event='font-toggle']",
    );
    const menu = this.querySelector<HTMLElement>("[aria-event='font-menu']");
    const list = this.querySelector<HTMLElement>("[aria-event='font-list']");

    if (button == null || menu == null || list == null) {
      return;
    }

    const rect = button.getBoundingClientRect();
    menu.style.width = `${Math.max(rect.width, FONT_MENU_MIN_WIDTH_PX)}px`;

    // The frame is not the scroller — the list inside it is, so that the search
    // box stays put while the names move under it. That has to be true *before*
    // anything is measured: with a `max-height` on the frame and none on the
    // list, `chrome` below comes out as the difference between a clamped height
    // and an unclamped one, which is negative, and undoes the clamp it exists
    // to apply.
    this.unclampFontFrame(menu);
    list.style.maxHeight = `${FONT_LIST_MAX_PX}px`;

    // Everything the menu is that is not the list: the search box and the
    // padding around it. Measured at the natural size, where it is a constant.
    const chrome = menu.offsetHeight - list.offsetHeight;

    // The anchor is the button's bottom edge, or its top edge when the menu
    // flips: `placeMenu` hangs a flipped menu's bottom on the anchor it was
    // given, so flipping about the bottom edge would cover the button the menu
    // opened from.
    let placement = applyMenuPlacement(menu, { x: rect.left, y: rect.bottom });
    if (placement.flipped) {
      placement = applyMenuPlacement(menu, { x: rect.left, y: rect.top });
    }

    // `applyMenuPlacement` writes the height it worked out onto whatever it
    // placed, so it is taken off the frame here and handed to the list.
    this.unclampFontFrame(menu);
    list.style.maxHeight = `${Math.max(
      FONT_LIST_MIN_PX,
      Math.min(FONT_LIST_MAX_PX, placement.maxHeight - chrome),
    )}px`;
  }

  /** Undo the height and the scroll `applyMenuPlacement` puts on the frame. */
  private unclampFontFrame(menu: HTMLElement) {
    menu.style.maxHeight = "";
    menu.style.overflowY = "visible";
  }

  /**
   * The name to show on the closed button.
   *
   * The bundled default is stored under its internal name and shown under its
   * real one, which is the same pair the list item has always used. A clip
   * whose `fontname` is missing is the only case with nothing to report, and
   * it is the only case that reads as a prompt.
   */
  private get selectedFontLabel(): string {
    if (!this.selectedFont) {
      return "Select Font";
    }

    // The *family*, because that is what the list offers and what the weight
    // row qualifies. Showing `AktivGrotesk-Bold` here beside a weight row
    // reading "Bold" says the same thing twice, and says it in two different
    // vocabularies.
    const family = parseFaceName(this.selectedFont).family;

    return family === DEFAULT_FONT_NAME ? DEFAULT_FONT_LABEL : family;
  }

  // ------------------------------------------------------- family and weight

  /** `fontList` grouped into families, recomputed only when the list grows. */
  private fontFamilies(): FontFamily[] {
    if (this.familiesCache?.size !== this.fontList.length) {
      this.familiesCache = {
        size: this.fontList.length,
        families: groupFontFamilies(this.fontList),
      };
    }
    return this.familiesCache.families;
  }

  /** The family the selected clip's `fontname` belongs to, if it is installed. */
  private currentFamily(): FontFamily | null {
    const family = parseFaceName(this.selectedFont ?? "").family.toLowerCase();
    return (
      this.fontFamilies().find(
        (candidate) => candidate.family.toLowerCase() === family,
      ) ?? null
    );
  }

  /**
   * The rungs the weight row offers.
   *
   * A family the machine does not have — a project carried here from another
   * machine — still has to show *something*, and what it shows is the weight
   * the clip is already at. Offering the full ladder there would be offering
   * eight choices that all resolve to the one file that is missing.
   */
  private availableWeights(): number[] {
    return this.currentFamily()?.weights ?? [this.selectedWeight];
  }

  /** The bundled default is stored under its internal name, shown under its own. */
  private familyLabel(family: FontFamily): string {
    return family.family === DEFAULT_FONT_NAME ? DEFAULT_FONT_LABEL : family.family;
  }

  /**
   * Switching family keeps the weight if the new family has one like it.
   *
   * Going from a Bold Aktiv Grotesk to Georgia, which ships only Regular and
   * Bold, should land on Georgia Bold — `faceFor`'s nearest-rung rule is what
   * decides, and it is the same rule CSS uses, so the result is the one a
   * stylesheet asking for the same weight would have picked.
   */
  handleChangeFontFamily(family: FontFamily) {
    this.closeFontMenu();
    this.applyFace(family, this.selectedWeight);
  }

  handleChangeFontWeight(event: Event) {
    const weight = coerceFontWeight((event.target as HTMLSelectElement).value);
    const family = this.currentFamily();

    if (family == null) {
      return;
    }

    this.applyFace(family, weight);
  }

  /**
   * Point the selection at one face of one family.
   *
   * `fontweight` is written alongside the three font fields even though the
   * renderer ignores it for a static face, because it is the only record of
   * *which rung was asked for*: the file name says 700 for a family that ships
   * one, and says nothing at all for a variable font, where the number is the
   * whole answer.
   */
  private applyFace(family: FontFamily, weight: number) {
    // Always the upright face, never the family's real italic — and that is
    // what `faceFor`'s slant argument is for here, rather than a feature this
    // panel uses. `options.isItalic` is a synthetic slant the renderer applies
    // on top of whatever face it is given, so choosing `AktivGrotesk-BoldItalic`
    // would slant an already-slanted file, and switching italic back off would
    // leave the clip italic with the button unlit. Italic stays orthogonal to
    // the weight row, exactly as it was before there was one.
    const face = faceFor(family, weight, false);

    if (face == null) {
      return;
    }

    // Injected before the commit so the very next repaint can draw with it —
    // the argument `agent/commands/appearance.ts` makes at its own call site.
    ensureFontFace(face.entry);

    this.selectedFont = face.entry.name;
    this.selectedWeight = family.variable ? weight : face.weight;

    const elementControl = document.querySelector("element-control");
    for (const elementId of this.elementId) {
      elementControl.changeTextFont({
        elementId,
        fontPath: face.entry.path,
        fontType: face.entry.type,
        fontName: face.entry.name,
        fontWeight: String(this.selectedWeight),
      });
    }

    this.requestUpdate();
  }
}

import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ensureFontFace, type FontEntry } from "../../features/font/fontFaces";
import {
  buildTextPresets,
  presetMatches,
  type PresetStyle,
  type TextPreset,
} from "../../features/font/textPresets";
import { renderOptionStore } from "../../states/renderOptionStore";
import { withAlpha as rgba } from "../../features/text/style";
import type { TextElementOptions } from "../../features/element/textElement";
import { defaultTextHeight } from "../../features/text/metrics";

/**
 * The font size a tile's `Aa` is drawn at. Outline widths and letter spacing are
 * authored in element space, against a font size derived from the project's
 * height, so the tile scales them by the ratio between the two — otherwise an
 * 8px outline that reads as a crisp edge on a 1080p title swallows the `Aa`.
 */
const PREVIEW_FONT_SIZE = 30;

/**
 * The "Text" asset panel: one plain-text tile, then a preset per bundled Google
 * Font and style.
 *
 * Each tile draws its own `Aa` in the family and style it would produce, which
 * is only possible because the panel injects the `@font-face` itself. That is
 * the same registration the canvas needs — `renderText` resolves `fontname` as
 * a CSS family — so showing an honest preview and making the element render
 * correctly are the same act. The old panel did neither: it drew a generic
 * `text_fields` icon, and `addCustomText` set a font path without ever
 * registering the face, so the clip came out in the fallback.
 *
 * Every string in this panel is English and stays English — it is not routed
 * through `LocaleController`. The families are Latin-only specimens, and a
 * Hangul label under an `Aa` that cannot render Hangul misrepresents the face.
 */
@customElement("control-ui-text")
export class ControlText extends LitElement {
  @state() private presets: TextPreset[] = [];
  @state() private query = "";

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.loadPresets();
  }

  private async loadPresets() {
    const result: { status?: number; fonts?: FontEntry[] } =
      await window.electronAPI.req.font.getPresetFontLists();

    const fonts = result?.fonts ?? [];

    // Register before building, so the very first paint of the tiles already
    // has the faces available and there is no flash of fallback.
    for (const font of fonts) {
      ensureFontFace(font);
    }

    // Assigning to an @state field is what schedules the re-render. The old
    // implementation pushed into a plain array from inside a `.then()` and
    // never asked Lit to update, so the tiles only appeared if something else
    // happened to re-render the panel.
    this.presets = buildTextPresets(fonts);
  }

  /**
   * Element-space geometry for a new text element, derived from the project's
   * own resolution rather than assuming 1080p — the same derivation
   * `features/agent/commands/text.ts#defaultLayout` uses for captions, but
   * centred vertically because these are titles, not subtitles.
   */
  private layoutFor(style: PresetStyle) {
    const { w, h } = renderOptionStore.getState().options.previewSize;
    const fontsize = Math.round((h / 20) * (style.sizeScale ?? 1));
    const height = defaultTextHeight(fontsize);

    return {
      fontsize,
      height,
      width: w,
      locationX: 0,
      locationY: Math.round(h / 2 - height / 2),
    };
  }

  private _handleClickPreset(preset: TextPreset) {
    // Belt and braces: the face was registered at load, but `ensureFontFace` is
    // idempotent and a preset must never produce an element in a family the
    // document cannot resolve.
    ensureFontFace({
      path: preset.path,
      name: preset.family,
      type: preset.type,
    });

    const { style } = preset;
    const options: TextElementOptions = {
      ...this.layoutFor(style),
      fontpath: preset.path,
      fontname: preset.family,
      fonttype: preset.type,
      textcolor: style.textcolor,
      letterSpacing: style.letterSpacing ?? 0,
      isBold: style.isBold ?? false,
      isItalic: style.isItalic ?? false,
      // Centred, not left — a preset's box spans the whole frame, so the
      // element default of `left` at x=0 puts a title hard against the edge
      // with its outline clipped off. The plain "Text" tile keeps the old
      // behaviour; these are titles.
      optionsAlign: style.align ?? "center",
      outline: style.outline
        ? { enable: true, size: style.outline.size, color: style.outline.color }
        : undefined,
      backgroundEnable: style.background != null,
      backgroundColor: style.background?.color ?? "#000000",
      shadow: style.shadow ? { enable: true, ...style.shadow } : undefined,
      glow: style.glow ? { enable: true, ...style.glow } : undefined,
      fill: style.gradient
        ? { type: "gradient" as const, ...style.gradient }
        : undefined,
    };

    const elementControlComponent = document.querySelector("element-control");
    elementControlComponent.addText(options);
  }

  private _handleClickAddFont() {
    const elementControlComponent = document.querySelector("element-control");
    elementControlComponent.addText({});
  }

  private _handleInputQuery(event: Event) {
    this.query = (event.target as HTMLInputElement).value;
  }

  /**
   * The tile's CSS, restating the preset in the properties the canvas draws.
   *
   * The subtle part is the outline. `renderText` calls `strokeText` and *then*
   * `fillText`, so the fill covers the inner half of the stroke and only the
   * outer half shows. CSS `-webkit-text-stroke` paints the stroke over the fill
   * instead, which at these widths turns the `Aa` into a solid black blob —
   * `paint-order: stroke fill` puts it back underneath and makes the tile match
   * the canvas. The width is also capped: an outline authored against a 54px
   * title, scaled down honestly, still reads as heavy at 30px.
   */
  private previewStyle(preset: TextPreset): string {
    const { style } = preset;
    const scale = PREVIEW_FONT_SIZE / this.layoutFor(style).fontsize;

    const rules = [
      `font-family: "${preset.family}", notosanskr, sans-serif`,
      `font-size: ${PREVIEW_FONT_SIZE}px`,
      `color: ${style.textcolor}`,
    ];

    if (style.isBold) {
      rules.push("font-weight: bold");
    }
    if (style.isItalic) {
      rules.push("font-style: italic");
    }
    if (style.letterSpacing) {
      // Letter spacing is applied after the last glyph too, so an indent of the
      // same size puts the pair back in the middle of the tile.
      const spacing = (style.letterSpacing * scale).toFixed(2);
      rules.push(`letter-spacing: ${spacing}px`);
      rules.push(`text-indent: ${spacing}px`);
    }
    if (style.outline) {
      const width = Math.min(3, Math.max(0.5, style.outline.size * scale));
      rules.push(
        `-webkit-text-stroke: ${width.toFixed(2)}px ${style.outline.color}`,
      );
      rules.push("paint-order: stroke fill");
    }
    // Shadow and glow both become `text-shadow`, which takes the same four
    // parameters the canvas does — offset, blur, colour — so the tile is a
    // direct restatement rather than an approximation. Both are scaled by the
    // same ratio as the type, keeping the tile proportional to the result.
    const shadows: string[] = [];
    if (style.glow) {
      const blur = (style.glow.size * scale).toFixed(2);
      shadows.push(`0 0 ${blur}px ${rgba(style.glow.color, style.glow.opacity)}`);
    }
    if (style.shadow) {
      const x = (style.shadow.offsetX * scale).toFixed(2);
      const y = (style.shadow.offsetY * scale).toFixed(2);
      const blur = (style.shadow.blur * scale).toFixed(2);
      shadows.push(
        `${x}px ${y}px ${blur}px ${rgba(style.shadow.color, style.shadow.opacity)}`,
      );
    }
    if (shadows.length > 0) {
      rules.push(`text-shadow: ${shadows.join(", ")}`);
    }

    if (style.gradient) {
      // The CSS way to put a gradient inside glyphs: paint it as the element's
      // background and clip it to the text. `color: transparent` is what lets
      // the clipped background show through.
      rules.push(
        `background-image: linear-gradient(${style.gradient.angle + 90}deg, ${
          style.gradient.from
        }, ${style.gradient.to})`,
      );
      rules.push("-webkit-background-clip: text");
      rules.push("background-clip: text");
      rules.push("color: transparent");
    } else if (style.background) {
      rules.push(`background-color: ${style.background.color}`);
    }

    return rules.join("; ");
  }

  private renderPreset(preset: TextPreset) {
    return html`<div
      class="col-6 d-flex flex-column bd-highlight overflow-hidden mt-1 asset"
      title=${preset.label}
      @click=${() => this._handleClickPreset(preset)}
    >
      <div class="text-preset-preview" style=${this.previewStyle(preset)}>
        Aa
      </div>
      <b class="text-light text-center text-preset-name"
        >${preset.fontLabel}</b
      >
      <span class="text-center text-preset-style"
        >${preset.styleLabel}</span
      >
    </div>`;
  }

  render() {
    const visible = this.presets.filter((preset) =>
      presetMatches(preset, this.query),
    );

    return html`
      <div class="px-2 pt-1">
        <input
          type="search"
          class="form-control form-control-sm bg-default text-light"
          placeholder="Search fonts"
          .value=${this.query}
          @input=${this._handleInputQuery}
        />
      </div>

      <div class="row px-2">
        <div
          class="col-6 d-flex flex-column bd-highlight overflow-hidden mt-1 asset"
          @click=${this._handleClickAddFont}
        >
          <div class="text-preset-preview text-preset-preview-plain">
            <span class="material-symbols-outlined icon-lg"> text_fields </span>
          </div>
          <b class="text-light text-center text-preset-name">Text</b>
          <span class="text-preset-style">&nbsp;</span>
        </div>

        ${visible.map((preset) => this.renderPreset(preset))}
      </div>
    `;
  }
}

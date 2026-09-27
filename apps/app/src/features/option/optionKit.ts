/**
 * The inspector's shared markup: section frames, rows, buttons and sliders that
 * every `option-*` panel builds from.
 *
 * Template functions rather than components, for two reasons. A component here
 * would have to take its contents as a `TemplateResult` property, since these
 * render into the light DOM and a `<slot>` never fills (see CLAUDE.md), so it
 * would cost a property per hole and buy nothing. And every panel in this
 * folder already carries its own test hooks: `data-adjust` on a row,
 * `data-shape-kind` on a kind button, `aria-event` on a control. A function that
 * returns the *inside* of a wrapper leaves the wrapper, and therefore those
 * attributes, where the suites can still see them.
 *
 * The look lives in `sass/style/_option.scss`. Two pieces are class-only and
 * have no helper here on purpose:
 *
 * - **a segmented control**: `<div class="opt-seg">` around
 *   `<button class="opt-seg-item">`, one of them `is-on`. Every caller's cells
 *   carry different attributes (`data-shape-kind`, `aria-event`), and a helper
 *   that took an attribute bag would be longer than the markup it replaced.
 * - **a card with no body**: `<div class="opt-section">` around `sectionHead`
 *   alone, which is what a section whose whole content is one control looks
 *   like.
 */

import { html, nothing, type TemplateResult } from "lit";

/** Anything renderable: a template, a string, or `nothing`. */
export type Renderable = unknown;

// ------------------------------------------------------------------ sections

export interface SectionHeadSpec {
  /**
   * The section's name, and the whole of what its head says.
   *
   * There is deliberately no icon here. A glyph beside the word is a second
   * name for the same thing, and eleven of them stacked down a 200px column
   * read as a list of pictures rather than as a list of sections. Icons belong
   * where they are the choice being made: the kind row, the mask shapes, the
   * stroke alignment, the tabs.
   */
  title: string;
  /** The controls at the far end of the head: `+`, the eye, Reset. */
  actions?: Renderable;
  /**
   * Whether the actions take the head's spare width instead of sitting at its
   * end. For a section whose whole content is one field, such as Blend.
   */
  grow?: boolean;
}

/** A section's title line: the name at one end, its controls at the other. */
export function sectionHead(spec: SectionHeadSpec): TemplateResult {
  return html`
    <div class="opt-head">
      <span class="opt-head-title">${spec.title}</span>
      ${spec.actions == null || spec.actions === ""
        ? nothing
        : html`<div
            class="opt-head-actions ${spec.grow === true ? "opt-head-grow" : ""}"
          >
            ${spec.actions}
          </div>`}
    </div>
  `;
}

export interface SectionSpec extends SectionHeadSpec {
  /**
   * The controls. Left out, the card is its head alone, which is what a section
   * with nothing set yet looks like: a name and the `+` that fills it.
   */
  body?: Renderable;
}

/** One whole section: the card, its head, and its body when it has one. */
export function section(spec: SectionSpec): TemplateResult {
  const { body, ...head } = spec;
  return html`
    <div class="opt-section">
      ${sectionHead(head)}
      ${body == null || body === "" || body === nothing
        ? nothing
        : html`<div class="opt-body">${body}</div>`}
    </div>
  `;
}

// ------------------------------------------------------------------- buttons

export interface IconButtonSpec {
  /** A Material Symbols ligature. */
  icon: string;
  /** The tooltip, and the accessible name: these buttons carry no text. */
  title: string;
  /** Drawn as engaged. */
  on?: boolean;
  disabled?: boolean;
  /** `aria-event`, which is how the e2e suites aim at a control. */
  event?: string;
  onClick: () => void;
}

/** A 22px square glyph button: the head's `+`, `x`, eye and link. */
export function iconButton(spec: IconButtonSpec): TemplateResult {
  return html`
    <button
      type="button"
      class="opt-icon-btn ${spec.on === true ? "is-on" : ""}"
      title=${spec.title}
      aria-label=${spec.title}
      aria-pressed=${spec.on === true ? "true" : "false"}
      aria-event=${spec.event ?? nothing}
      ?disabled=${spec.disabled === true}
      @click=${spec.onClick}
    >
      <span class="material-symbols-outlined">${spec.icon}</span>
    </button>
  `;
}

/**
 * The show/hide toggle a section that is always present carries instead of `+`.
 *
 * `open` is where the user is looking rather than anything about the clip, so
 * every caller holds it as component state and none of it reaches the document.
 */
export function eyeButton(
  open: boolean,
  title: string,
  onClick: () => void,
  event?: string,
): TemplateResult {
  return iconButton({
    icon: open ? "visibility" : "visibility_off",
    title,
    on: open,
    event,
    onClick,
  });
}

export interface TextButtonSpec {
  label: string;
  title?: string;
  disabled?: boolean;
  event?: string;
  onClick: () => void;
}

/** A word at the icon button's height: Reset, Remove. */
export function textButton(spec: TextButtonSpec): TemplateResult {
  return html`
    <button
      type="button"
      class="opt-text-btn"
      title=${spec.title ?? spec.label}
      aria-event=${spec.event ?? nothing}
      ?disabled=${spec.disabled === true}
      @click=${spec.onClick}
    >
      ${spec.label}
    </button>
  `;
}

// -------------------------------------------------------------------- fields

/** Where a value sits in its range, as the percentage the track is filled to. */
export function fillPercent(value: number, min: number, max: number): string {
  if (!(max > min) || !Number.isFinite(value)) {
    return "0%";
  }
  const ratio = (value - min) / (max - min);
  return `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
}

export interface SliderFieldSpec {
  label: string;
  /** The unit, shown in brackets after the name when it is not obvious. */
  suffix?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /**
   * The value the track is drawn against, when it is not `value`: a radius
   * whose box is smaller than the number typed into it, for instance.
   */
  rangeValue?: number;
  /** A range that runs both ways: a centre mark, and a fill from the middle. */
  bipolar?: boolean;
  /** Drawn quiet, for a value sitting at its default. */
  dim?: boolean;
  /** A control between the number box and the row's end, such as a link toggle. */
  trailing?: Renderable;
  labelTitle?: string;
  onLabelDblClick?: () => void;
  /** Every `input` of a drag. Expected to go through `GestureCommit`. */
  onScrub: (next: number) => void;
  /** The drag's end. Expected to flush the gesture. */
  onCommit: () => void;
  /** A number typed into the box. Only ever called with a finite value. */
  onTyped: (next: number) => void;
  /**
   * A box left holding something that is not a number. Callers re-render, which
   * puts the document's own value back rather than storing a NaN.
   */
  onInvalid?: () => void;
}

/**
 * A named value: the name and its box on one line, the slider full width under
 * them.
 *
 * Returns the row and the slider, without a wrapper, so the caller's own
 * element keeps whatever attribute its suite aims at.
 */
export function sliderField(spec: SliderFieldSpec): TemplateResult {
  const step = spec.step ?? 1;
  const shown = spec.rangeValue ?? spec.value;
  const at = fillPercent(shown, spec.min, spec.max);
  // A bipolar track is filled between the middle and the head, whichever side
  // the head is on, so zero reads as empty rather than as half full.
  const from = spec.bipolar === true ? fillPercent(0, spec.min, spec.max) : "0%";
  const style =
    spec.bipolar === true
      ? `--opt-fill-from: ${
          parseFloat(at) < parseFloat(from) ? at : from
        }; --opt-fill: ${parseFloat(at) < parseFloat(from) ? from : at};`
      : `--opt-fill: ${at};`;

  return html`
    <div class="opt-row">
      <label
        class="opt-label"
        style=${spec.dim === true ? "opacity: 0.65;" : nothing}
        title=${spec.labelTitle ?? nothing}
        @dblclick=${spec.onLabelDblClick ?? nothing}
      >
        ${spec.label}${spec.suffix == null || spec.suffix === ""
          ? ""
          : ` (${spec.suffix})`}
      </label>
      <input
        type="number"
        class="opt-num"
        min=${String(spec.min)}
        max=${String(spec.max)}
        step=${String(step)}
        .value=${String(Math.round(spec.value))}
        @change=${(event: Event) => {
          const next = Number((event.target as HTMLInputElement).value);
          if (!Number.isFinite(next)) {
            spec.onInvalid?.();
            return;
          }
          spec.onTyped(next);
        }}
      />
      ${spec.trailing ?? nothing}
    </div>
    ${spec.bipolar === true
      ? html`<div class="opt-slider-wrap">
          <span class="opt-slider-zero" aria-hidden="true"></span>
          ${rangeInput(spec, shown, step, style)}
        </div>`
      : rangeInput(spec, shown, step, style)}
  `;
}

/** The slider half of `sliderField`, which the bipolar branch wraps. */
function rangeInput(
  spec: SliderFieldSpec,
  shown: number,
  step: number,
  style: string,
): TemplateResult {
  return html`<input
    type="range"
    class="opt-slider"
    style=${style}
    min=${String(spec.min)}
    max=${String(spec.max)}
    step=${String(step)}
    .value=${String(shown)}
    @input=${(event: Event) =>
      spec.onScrub(Number((event.target as HTMLInputElement).value))}
    @change=${spec.onCommit}
  />`;
}

export interface ColorFieldSpec {
  label: string;
  value: string;
  /** `aria-event`, which is how the e2e suites aim at a control. */
  event?: string;
  /** Every `input` of a picker drag. Expected to go through `GestureCommit`. */
  onScrub: (next: string) => void;
  /** The drag's end. Expected to flush the gesture. */
  onCommit: () => void;
}

/**
 * A colour: its name, its hex, and the swatch that opens the picker.
 *
 * `input` scrubs and `change` commits, as `optionShapeSection`'s header
 * records: a picker drag fires `input` continuously, and writing each one
 * through `withCheckpoint` cost an undo step per event.
 */
export function colorField(spec: ColorFieldSpec): TemplateResult {
  return html`
    <div class="opt-row">
      <label class="opt-label">${spec.label}</label>
      <span class="opt-value">${spec.value.toUpperCase()}</span>
      <input
        type="color"
        class="opt-swatch"
        aria-event=${spec.event ?? nothing}
        title=${spec.label}
        .value=${spec.value}
        @input=${(event: Event) =>
          spec.onScrub((event.target as HTMLInputElement).value)}
        @change=${spec.onCommit}
      />
    </div>
  `;
}

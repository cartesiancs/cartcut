/**
 * Controls generated from a preset's declared parameters.
 *
 * The whole point of the preset format, made visible: a third-party preset gets
 * a real UI without shipping a line of code. Nothing here knows what `rain` or
 * `wipe` is — it reads `params` off the manifest and renders one control per
 * entry, which is why installing a folder is all it takes to get a working
 * panel.
 *
 * Shared by `<option-effect>` and `<option-transition>` because the parameter
 * schema is shared. The two panels differ in what surrounds these: an effect
 * adds intensity and a blend mode, a transition adds duration and alignment.
 *
 * Two conventions from `optionVideo.ts` are load-bearing here:
 *
 *  - **Bind with `.value`, never `value`.** The attribute form is a *default*
 *    that lit writes once, so a panel built that way shows the first clip's
 *    settings for every clip after it.
 *  - **Scrubs go through `GestureCommit`.** A slider emits `input` per pixel;
 *    without coalescing, one drag becomes a hundred undo steps.
 */

import { html, type TemplateResult } from "lit";
import type { AnimatableProperty } from "../../@types/timeline";
import type {
  FxParamSpec,
  FxParamValues,
  HtmlParamSpec,
  PresetParamSpec,
} from "./presetTypes";
import { scrubOn } from "../input/inputScrub";
import { sweepSpec } from "../input/numberScrub";
import "../option/controlKeyframeNav";
import { iconButton, sliderField } from "../option/optionKit";

export type ParamChange = (key: string, value: number | string | boolean | number[]) => void;

/**
 * What a panel must supply for a parameter row to carry a keyframe diamond.
 *
 * Optional, and `<option-transition>` supplies none: a transition has no
 * `animation` block, and its `progress` already owns the time inside its
 * window. `<option-effect>` supplies one whose `trackFor` answers only for
 * `type: "number"`.
 *
 * That refusal lives here, on the panel side, rather than in
 * `animatableProperties`, which cannot read the manifest and so offers a track
 * for any parameter whose stored value is a number, a `select` included. This
 * is where the manifest gets the last word.
 */
export type ParamKeyframeHost = {
  elementId: string;
  /** The track name for a parameter, or `null` when it may not carry one. */
  trackFor: (param: PresetParamSpec) => AnimatableProperty | null;
};

/** A typeface a `font` parameter can be set to, as the panel lists it. */
export type FontChoice = { value: string; label: string };

export type ParamControlOptions = {
  params: PresetParamSpec[];
  values: FxParamValues;
  /** Called continuously while a slider moves; coalesce these. */
  onScrub: ParamChange;
  /** Called when a control settles — a committed edit. */
  onCommit: ParamChange;
  /** Absent on a panel whose parameters cannot be animated. */
  keyframe?: ParamKeyframeHost;
  /** What a `font` parameter offers. The panel loads it; absent shows the value alone. */
  fonts?: FontChoice[];
  /** Asks the user for a picture, for an `image` parameter. `null` when cancelled. */
  pickImage?: () => Promise<string | null>;
};

/** The value to show, falling back to the preset's default. */
function valueOf(param: FxParamSpec, values: FxParamValues) {
  const stored = values[param.key];
  switch (param.type) {
    case "number":
      return typeof stored === "number" ? stored : param.default;
    case "color":
      return typeof stored === "string" ? stored : param.default;
    case "bool":
      return typeof stored === "boolean" ? stored : param.default;
    case "select":
      return typeof stored === "number" ? stored : param.default;
    case "point":
    default:
      return Array.isArray(stored) && stored.length === 2
        ? (stored as number[])
        : param.default;
  }
}

/**
 * One parameter, drawn the way every other named value in the inspector is:
 * name at one end of the row, value at the other, and a slider full width
 * beneath when there is a range to sweep.
 *
 * Shared by the effect and the transition panels, and therefore the one place
 * a manifest's parameters get their look. They were Bootstrap rows here, which
 * is why an effect's Intensity and its preset's own parameters used to sit in
 * two different layouts inside one panel.
 */
function numberControl(
  param: Extract<FxParamSpec, { type: "number" }>,
  values: FxParamValues,
  opts: ParamControlOptions,
): TemplateResult {
  const value = valueOf(param, values) as number;
  // A step is only a suggestion for the spinner; the slider needs one fine
  // enough that a 0..1 parameter is not three positions wide.
  const step = param.step ?? (param.max - param.min) / 100;
  const track = opts.keyframe?.trackFor(param) ?? null;

  return html`
    <div class="opt-field">
      ${sliderField({
        label: param.label,
        value,
        min: param.min,
        max: param.max,
        step,
        bipolar: param.min < 0,
        trailing:
          track == null || opts.keyframe == null
            ? undefined
            : html`<control-keyframe-nav
                .elementId=${opts.keyframe.elementId}
                .property=${track}
                .label=${param.label}
              ></control-keyframe-nav>`,
        onScrub: (next) => opts.onScrub(param.key, next),
        onCommit: (next) => opts.onCommit(param.key, next),
        onTyped: (next) => opts.onCommit(param.key, next),
      })}
    </div>
  `;
}

function colorControl(
  param: Extract<FxParamSpec, { type: "color" }>,
  values: FxParamValues,
  opts: ParamControlOptions,
): TemplateResult {
  const value = valueOf(param, values) as string;
  const hex = value.startsWith("#") ? value : "#" + value;
  return html`
    <div class="opt-field">
      <div class="opt-row">
        <label class="opt-label" title=${param.label}>${param.label}</label>
        <span class="opt-value">${hex.toUpperCase()}</span>
        <input
          type="color"
          class="opt-swatch"
          title=${param.label}
          .value=${hex}
          @input=${(e: Event) =>
            opts.onScrub(param.key, (e.target as HTMLInputElement).value)}
          @change=${(e: Event) =>
            opts.onCommit(param.key, (e.target as HTMLInputElement).value)}
        />
      </div>
    </div>
  `;
}

/**
 * A flag, as the eye every other on/off in the inspector uses.
 *
 * Not a Bootstrap checkbox any more, which is why the per-instance `id` the
 * label's `for` needed is gone: two panels can mount the same preset at once,
 * and both checkboxes then carried the same id.
 */
function boolControl(
  param: Extract<FxParamSpec, { type: "bool" }>,
  values: FxParamValues,
  opts: ParamControlOptions,
): TemplateResult {
  const value = valueOf(param, values) as boolean;
  return html`
    <div class="opt-field">
      <div class="opt-row">
        <label class="opt-label" title=${param.label}>${param.label}</label>
        ${iconButton({
          icon: value ? "visibility" : "visibility_off",
          title: param.label,
          on: value,
          onClick: () => opts.onCommit(param.key, !value),
        })}
      </div>
    </div>
  `;
}

function selectControl(
  param: Extract<FxParamSpec, { type: "select" }>,
  values: FxParamValues,
  opts: ParamControlOptions,
): TemplateResult {
  const value = valueOf(param, values) as number;
  return html`
    <div class="opt-field">
      <div class="opt-row">
        <label class="opt-label" title=${param.label}>${param.label}</label>
        <select
          class="opt-select"
          style="width: 60%;"
          aria-label=${param.label}
          .value=${String(value)}
          @change=${(e: Event) =>
            opts.onCommit(
              param.key,
              Number((e.target as HTMLSelectElement).value),
            )}
        >
          ${param.options.map(
            (option) =>
              html`<option value=${String(option.value)}>
                ${option.label}
              </option>`,
          )}
        </select>
      </div>
    </div>
  `;
}

/**
 * Two numbers, for a `vec2`.
 *
 * The kind of parameter `gl-transitions` shaders call `direction` or `center`.
 * Two plain fields rather than an XY pad: a direction is often typed exactly
 * (`0, 1`) and a pad makes that the hard case.
 */
function pointControl(
  param: Extract<FxParamSpec, { type: "point" }>,
  values: FxParamValues,
  opts: ParamControlOptions,
): TemplateResult {
  const value = valueOf(param, values) as number[];
  const step = param.step ?? (param.max - param.min) / 100;
  const scrub = scrubOn(sweepSpec(param.min, param.max, step));

  const write = (index: 0 | 1, raw: string) => {
    const next = [...value];
    next[index] = Number(raw);
    opts.onCommit(param.key, next);
  };

  return html`
    <div class="opt-field">
      <div class="opt-row">
        <label class="opt-label" title=${param.label}>${param.label}</label>
        <div class="opt-row-controls">
          ${([0, 1] as const).map(
            (index) => html`
              <input
                type="number"
                class="opt-num scrub-number"
                min=${param.min}
                max=${param.max}
                step=${step}
                .value=${String(value[index])}
                @mousedown=${scrub}
                @change=${(e: Event) =>
                  write(index, (e.target as HTMLInputElement).value)}
              />
            `,
          )}
        </div>
      </div>
    </div>
  `;
}

function stringValueOf(param: HtmlParamSpec, values: FxParamValues): string {
  const stored = values[param.key];
  return typeof stored === "string" ? stored : param.default;
}

/**
 * Words the program shows. Typed changes scrub, so a sentence is one undo step
 * when the field is left; nothing is sent while an IME is composing, or a
 * Korean syllable would be committed one jamo at a time.
 */
function textControl(
  param: Extract<HtmlParamSpec, { type: "text" }>,
  values: FxParamValues,
  opts: ParamControlOptions,
): TemplateResult {
  const value = stringValueOf(param, values);
  const limit = Math.min(5000, param.maxLength ?? 500);
  const onInput = (e: Event) => {
    if ((e as InputEvent).isComposing) {
      return;
    }
    opts.onScrub(param.key, (e.target as HTMLInputElement).value.slice(0, limit));
  };
  const onEnd = (e: Event) =>
    opts.onScrub(param.key, (e.target as HTMLInputElement).value.slice(0, limit));
  const onChange = (e: Event) =>
    opts.onCommit(param.key, (e.target as HTMLInputElement).value.slice(0, limit));
  return html`
    <div class="opt-field">
      <div class="opt-row">
        <label class="opt-label" title=${param.label}>${param.label}</label>
      </div>
      ${param.multiline === true
        ? html`<textarea
            class="opt-textarea"
            rows="3"
            style="margin-top: 4px;"
            aria-label=${param.label}
            maxlength=${limit}
            .value=${value}
            @input=${onInput}
            @compositionend=${onEnd}
            @change=${onChange}
          ></textarea>`
        : html`<input
            type="text"
            class="opt-text-input"
            style="width: 100%; margin-top: 4px;"
            aria-label=${param.label}
            maxlength=${limit}
            .value=${value}
            @input=${onInput}
            @compositionend=${onEnd}
            @change=${onChange}
          />`}
    </div>
  `;
}

/** A typeface, from the list the panel loaded. The current value is always offered. */
function fontControl(
  param: Extract<HtmlParamSpec, { type: "font" }>,
  values: FxParamValues,
  opts: ParamControlOptions,
): TemplateResult {
  const value = stringValueOf(param, values);
  const choices = opts.fonts ?? [];
  const listed = choices.some((choice) => choice.value === value);
  const label = (v: string) =>
    v === "default" ? "Default" : (v.split(/[\\/:]/).pop() ?? v);
  return html`
    <div class="opt-field">
      <div class="opt-row">
        <label class="opt-label" title=${param.label}>${param.label}</label>
        <select
          class="opt-select"
          style="width: 60%;"
          aria-label=${param.label}
          .value=${value}
          @change=${(e: Event) =>
            opts.onCommit(param.key, (e.target as HTMLSelectElement).value)}
        >
          ${listed ? "" : html`<option value=${value} selected>${label(value)}</option>`}
          ${choices.map(
            (choice) =>
              html`<option value=${choice.value} ?selected=${choice.value === value}>
                ${choice.label}
              </option>`,
          )}
        </select>
      </div>
    </div>
  `;
}

/** A picture: its file name, a button to choose another, and one to clear it. */
function imageControl(
  param: Extract<HtmlParamSpec, { type: "image" }>,
  values: FxParamValues,
  opts: ParamControlOptions,
): TemplateResult {
  const value = stringValueOf(param, values);
  const name = value === "" ? "None" : (value.split(/[\\/]/).pop() ?? value);
  return html`
    <div class="opt-field">
      <div class="opt-row">
        <label class="opt-label" title=${param.label}>${param.label}</label>
        <span class="opt-value" title=${value}>${name}</span>
        ${opts.pickImage == null
          ? ""
          : iconButton({
              icon: "image",
              title: "Choose a picture",
              onClick: () => {
                void opts.pickImage?.().then((path) => {
                  if (path != null && path !== "") {
                    opts.onCommit(param.key, path);
                  }
                });
              },
            })}
        ${value === ""
          ? ""
          : iconButton({
              icon: "close",
              title: "Clear",
              onClick: () => opts.onCommit(param.key, ""),
            })}
      </div>
    </div>
  `;
}

/**
 * One control per declared parameter, in manifest order. Every type is named:
 * the fallback used to be the point editor, so a type added without a case
 * here rendered as two number boxes and no error anywhere.
 */
export function renderParamControls(
  opts: ParamControlOptions,
): TemplateResult[] {
  return opts.params.map((param) => {
    switch (param.type) {
      case "number":
        return numberControl(param, opts.values, opts);
      case "color":
        return colorControl(param, opts.values, opts);
      case "bool":
        return boolControl(param, opts.values, opts);
      case "select":
        return selectControl(param, opts.values, opts);
      case "point":
        return pointControl(param, opts.values, opts);
      case "text":
        return textControl(param, opts.values, opts);
      case "font":
        return fontControl(param, opts.values, opts);
      case "image":
        return imageControl(param, opts.values, opts);
      default:
        return html``;
    }
  });
}

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
import type { FxParamSpec, FxParamValues } from "./presetTypes";

export type ParamChange = (key: string, value: number | string | boolean | number[]) => void;

export type ParamControlOptions = {
  params: FxParamSpec[];
  values: FxParamValues;
  /** Called continuously while a slider moves; coalesce these. */
  onScrub: ParamChange;
  /** Called when a control settles — a committed edit. */
  onCommit: ParamChange;
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

function label(param: FxParamSpec): TemplateResult {
  return html`<label class="form-label text-secondary" style="font-size: 11px;">
    ${param.label}
  </label>`;
}

function numberControl(
  param: Extract<FxParamSpec, { type: "number" }>,
  values: FxParamValues,
  opts: ParamControlOptions,
): TemplateResult {
  const value = valueOf(param, values) as number;
  // A step is only a suggestion for the spinner; the slider needs one fine
  // enough that a 0..1 parameter is not three positions wide.
  const step = param.step ?? (param.max - param.min) / 100;

  return html`
    <div class="mb-2">
      ${label(param)}
      <div class="d-flex gap-2 align-items-center">
        <input
          type="range"
          class="form-range"
          min=${param.min}
          max=${param.max}
          step=${step}
          .value=${String(value)}
          @input=${(e: Event) =>
            opts.onScrub(param.key, Number((e.target as HTMLInputElement).value))}
          @change=${(e: Event) =>
            opts.onCommit(param.key, Number((e.target as HTMLInputElement).value))}
        />
        <input
          type="number"
          class="form-control bg-default text-light form-control-sm"
          style="width: 5.5rem;"
          min=${param.min}
          max=${param.max}
          step=${step}
          .value=${String(value)}
          @change=${(e: Event) =>
            opts.onCommit(param.key, Number((e.target as HTMLInputElement).value))}
        />
      </div>
    </div>
  `;
}

function colorControl(
  param: Extract<FxParamSpec, { type: "color" }>,
  values: FxParamValues,
  opts: ParamControlOptions,
): TemplateResult {
  const value = valueOf(param, values) as string;
  return html`
    <div class="mb-2">
      ${label(param)}
      <input
        type="color"
        class="form-control bg-default text-light form-control-sm"
        .value=${value.startsWith("#") ? value : "#" + value}
        @input=${(e: Event) =>
          opts.onScrub(param.key, (e.target as HTMLInputElement).value)}
        @change=${(e: Event) =>
          opts.onCommit(param.key, (e.target as HTMLInputElement).value)}
      />
    </div>
  `;
}

function boolControl(
  param: Extract<FxParamSpec, { type: "bool" }>,
  values: FxParamValues,
  opts: ParamControlOptions,
): TemplateResult {
  const value = valueOf(param, values) as boolean;
  return html`
    <div class="form-check mb-2">
      <input
        type="checkbox"
        class="form-check-input"
        id=${"fxparam-" + param.key}
        .checked=${value}
        @change=${(e: Event) =>
          opts.onCommit(param.key, (e.target as HTMLInputElement).checked)}
      />
      <label
        class="form-check-label text-secondary"
        style="font-size: 11px;"
        for=${"fxparam-" + param.key}
      >
        ${param.label}
      </label>
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
    <div class="mb-2">
      ${label(param)}
      <select
        class="form-select bg-dark text-light form-select-sm"
        .value=${String(value)}
        @change=${(e: Event) =>
          opts.onCommit(param.key, Number((e.target as HTMLSelectElement).value))}
      >
        ${param.options.map(
          (option) =>
            html`<option value=${String(option.value)}>${option.label}</option>`,
        )}
      </select>
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

  const write = (index: 0 | 1, raw: string) => {
    const next = [...value];
    next[index] = Number(raw);
    opts.onCommit(param.key, next);
  };

  return html`
    <div class="mb-2">
      ${label(param)}
      <div class="d-flex gap-2">
        ${([0, 1] as const).map(
          (index) => html`
            <input
              type="number"
              class="form-control bg-default text-light form-control-sm"
              min=${param.min}
              max=${param.max}
              step=${step}
              .value=${String(value[index])}
              @change=${(e: Event) =>
                write(index, (e.target as HTMLInputElement).value)}
            />
          `,
        )}
      </div>
    </div>
  `;
}

/** One control per declared parameter, in manifest order. */
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
      default:
        return pointControl(param, opts.values, opts);
    }
  });
}

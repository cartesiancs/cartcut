/**
 * A shape's backdrop effect and its fill's own opacity: the read guards that
 * run on every draw and the coercers that run once, where a value is stored.
 *
 * The `normalizeX` / `coerceX` split every optional field here follows. A read
 * guard must never throw and hands back what is stored **by identity** when it
 * is usable, so a renderer caching on the object keeps its cache; a coercer
 * makes an unusable value unrepresentable from the moment it is written.
 *
 * Neither knows about the preset registry, which reads from disk. Whether a
 * preset is one a backdrop may carry is `fx/backdropPreset.ts`'s question,
 * asked by the writer that has a registry and by `planFrame` on the way out.
 */

import type {
  BackdropFx,
  FxParams,
  InlineProgram,
} from "../../@types/timeline";
import { isInlinePresetId } from "../../@types/timeline";
import { sameProgram } from "../fx/inlineProgram";
import { sameParams } from "../timeline/effectOps";

/** What an effect starts at, and what a backdrop with no usable number reads as. */
export const DEFAULT_BACKDROP_INTENSITY = 100;

/** A fill at full strength, which is what an absent `fillOpacity` means. */
export const OPAQUE_FILL = 100;

/**
 * The backdrop a shape carries, or `null` when it has none it could draw.
 *
 * Only a shape: the field means nothing on any other element, and a hand-edited
 * file that put one on a video must not buy that frame a scratch pass.
 */
export function backdropFxOf(element: unknown): BackdropFx | null {
  const holder = element as { filetype?: unknown; backdropFx?: unknown } | null;
  if (holder == null || holder.filetype !== "shape") {
    return null;
  }
  const raw = holder.backdropFx as Partial<BackdropFx> | null | undefined;
  if (raw == null || typeof raw !== "object") {
    return null;
  }
  if (typeof raw.presetId !== "string" || raw.presetId === "") {
    return null;
  }
  return raw as BackdropFx;
}

/**
 * A backdrop's strength as the shader should receive it, 0-100.
 *
 * Read here rather than straight off the field because a hand-edited file can
 * hold anything there, and an `intensity` of `NaN` reaching the uniform would
 * draw the whole region black.
 */
export function backdropIntensityOf(fx: BackdropFx): number {
  const value = fx.intensity;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_BACKDROP_INTENSITY;
  }
  return clampPercent(value);
}

/** A backdrop's parameters, `{}` when the stored value is not an object. */
export function backdropParamsOf(fx: BackdropFx): FxParams {
  const params = fx.params;
  return params != null && typeof params === "object" && !Array.isArray(params)
    ? params
    : {};
}

/** The fill's own opacity, 0-100. Absent, or anything unusable, reads as 100. */
export function fillOpacityOf(element: unknown): number {
  const option = (element as { option?: { fillOpacity?: unknown } } | null)
    ?.option;
  const value = option?.fillOpacity;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return OPAQUE_FILL;
  }
  return clampPercent(value);
}

export type BackdropFxInput = {
  presetId: string;
  params?: FxParams | null;
  intensity?: number | null;
  /** Present exactly when `presetId` is an inline one. */
  program?: InlineProgram | null;
};

/**
 * A backdrop that can be stored, or `null` when the input cannot be one.
 *
 * Declines rather than repairs a missing preset id or an inline id with no
 * program beside it: either would be stored as a backdrop that can never
 * draw, and with the fill made transparent for it the shape would look like
 * nothing at all. `program` is kept exactly when the id is an inline one, the
 * rule `ProgramBacked` states, so a stale program cannot ride along on an
 * installed preset.
 */
export function coerceBackdropFx(input: BackdropFxInput | null | undefined): BackdropFx | null {
  if (input == null || typeof input.presetId !== "string" || input.presetId === "") {
    return null;
  }
  const inline = isInlinePresetId(input.presetId);
  if (inline && input.program == null) {
    return null;
  }

  const intensity =
    typeof input.intensity === "number" && Number.isFinite(input.intensity)
      ? clampPercent(input.intensity)
      : DEFAULT_BACKDROP_INTENSITY;

  const out: BackdropFx = {
    presetId: input.presetId,
    params: coerceParams(input.params),
    intensity,
  };
  if (inline && input.program != null) {
    out.program = input.program;
  }
  return out;
}

/**
 * The opacity to store, or `undefined` for "delete the key".
 *
 * Clamped rather than refused, the rule `setEffectIntensity` follows: a slider
 * scrubbed past its end settles on the bound instead of recording nothing.
 * Anything that is not a finite number is refused outright, as `null`.
 */
export function coerceFillOpacity(value: unknown): number | undefined | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const clamped = clampPercent(value);
  return clamped === OPAQUE_FILL ? undefined : clamped;
}

/** Whether two backdrops would draw the same thing. */
export function sameBackdropFx(a: BackdropFx | null, b: BackdropFx | null): boolean {
  if (a == null || b == null) {
    return a === b;
  }
  return (
    a.presetId === b.presetId &&
    a.intensity === b.intensity &&
    sameParams(backdropParamsOf(a), backdropParamsOf(b)) &&
    sameProgram(a.program, b.program)
  );
}

/**
 * Only the value types a preset parameter can hold, and only finite numbers.
 *
 * A parameter the preset does not declare is kept: the manifest owns the
 * schema and `glslWrap.ts#uniformValueOf` ignores what it does not name, so
 * dropping unknown keys here would only lose data on a machine where the
 * preset is a newer version.
 */
function coerceParams(raw: unknown): FxParams {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: FxParams = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number") {
      if (Number.isFinite(value)) {
        out[key] = value;
      }
    } else if (typeof value === "string" || typeof value === "boolean") {
      out[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ) {
      out[key] = [...value] as number[];
    }
  }
  return out;
}

function clampPercent(value: number): number {
  return value < 0 ? 0 : value > 100 ? 100 : value;
}

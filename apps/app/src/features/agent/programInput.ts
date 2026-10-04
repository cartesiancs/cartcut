/**
 * Turning a program an agent sent into one a clip can carry, or a message that
 * says exactly what to fix.
 *
 * Shared by every command that accepts `program`: `check_program`, the four fx
 * commands, and the graphic ones. Each needs the same three steps in the same
 * order, and an agent should get the same answer to the same program whichever
 * tool it used:
 *
 *  1. `coerceInlineProgram`, which normalises, sanitises and validates;
 *  2. a real compile where there is a GL context, because GLSL errors are the
 *     ones `validatePreset` cannot see;
 *  3. the program's default parameters, with whatever the caller passed laid
 *     over them, because a program arriving with no values must still draw.
 */

import type { FxParams, InlineProgram } from "../../@types/timeline";
import { coerceInlineProgram, toRawPayload, type Diagnostic } from "../fx/inlineProgram";
import { defaultParamsOf, type FxPreset } from "../fx/presetTypes";
import { validatePreset } from "../fx/presetValidate";
import { checkCompiles } from "../renderer/fx/compileCheck";

export type CheckedProgram = {
  program: InlineProgram;
  preset: FxPreset;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  /** `false` where there was no GL context to compile in. */
  compiled: boolean;
};

/** One diagnostic as a line an agent can read: `main.frag:3: message`. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const where =
    diagnostic.file == null
      ? ""
      : diagnostic.file + (diagnostic.line != null ? ":" + diagnostic.line : "") + ": ";
  return where + diagnostic.message;
}

export function formatDiagnostics(list: Diagnostic[]): string {
  return list.map(formatDiagnostic).join("\n");
}

/**
 * Validate and compile a program. Never throws; `errors` is empty exactly when
 * the program would draw. `preset` is `null` only when validation failed.
 */
export function checkProgram(raw: unknown):
  | CheckedProgram
  | { program: null; preset: null; errors: Diagnostic[]; warnings: Diagnostic[]; compiled: false } {
  const coerced = coerceInlineProgram(raw);
  if (!coerced.ok) {
    return { program: null, preset: null, errors: coerced.errors, warnings: [], compiled: false };
  }
  const validated = validatePreset(toRawPayload(coerced.program));
  if (!validated.ok) {
    // `coerceInlineProgram` already ran this, so it cannot fail here; answering
    // anyway keeps the type honest.
    return {
      program: null,
      preset: null,
      errors: validated.errors.map((message) => ({ message })),
      warnings: coerced.warnings,
      compiled: false,
    };
  }
  const compiled = checkCompiles(validated.preset);
  return {
    program: coerced.program,
    preset: validated.preset,
    errors: compiled?.errors ?? [],
    warnings: [...coerced.warnings, ...(compiled?.warnings ?? [])],
    compiled: compiled != null,
  };
}

/**
 * The program, its preset and the full parameter set to store, or an `Error`
 * whose message lists every problem. For the commands that place or change a
 * clip, where a program that does not draw must not be stored at all.
 */
export function requireProgram(
  raw: unknown,
  kind: "effect" | "transition" | "graphic",
  overrides: Record<string, unknown> | undefined,
): { program: InlineProgram; preset: FxPreset; params: FxParams; warnings: Diagnostic[] } {
  const declaredKind = (raw as { kind?: unknown } | null)?.kind;
  if (declaredKind !== kind) {
    throw new Error(
      `This program is a ${String(declaredKind)}, and this tool places a ${kind}. Set program.kind to "${kind}".`,
    );
  }
  const checked = checkProgram(raw);
  if (checked.program == null || checked.errors.length > 0) {
    throw new Error(
      "The program was not stored, because:\n" + formatDiagnostics(checked.errors),
    );
  }
  return {
    program: checked.program,
    preset: checked.preset as FxPreset,
    params: { ...defaultParamsOf(checked.preset as FxPreset), ...((overrides ?? {}) as FxParams) },
    warnings: checked.warnings,
  };
}

/**
 * The preset an element actually uses.
 *
 * An installed preset is a registry lookup by id. An inline one is built from
 * the element's own `program`, validated exactly as a folder would be, and
 * remembered so that a clip drawn sixty times a second is validated once.
 *
 * The read side of `inlineProgram.ts#coerceInlineProgram`, and like every read
 * side in this codebase it never throws: a program that does not validate is a
 * missing preset, which the compositor already knows how to draw (pass-through
 * for an effect, a cut for a transition, nothing for a graphic). The element
 * keeps the program untouched, so saving loses nothing.
 *
 * Two layers of memory. A `WeakMap` on the program object, because the document
 * is immutable and an unchanged clip hands over the same object every frame.
 * Behind it a bounded map keyed by the stored hash, for the programs a load or
 * a paste rebuilt as new objects. `digest64` is not cryptographic, so a hit there
 * is confirmed by comparing the canonical text before it is trusted: two
 * different programs claiming one hash must not share a result.
 */

import type { InlineProgram } from "../../@types/timeline";
import { isInlinePresetId } from "../../@types/timeline";
import { BoundedCache } from "../renderer/lut/boundedCache";
import { toRawPayload, type Diagnostic, diagnosticOf } from "./inlineProgram";
import { canonicalProgramText, hashProgram, type ProgramContent } from "./programHash";
import { presetById } from "./presetRegistry";
import type { FxPreset } from "./presetTypes";
import { validatePreset } from "./presetValidate";

type Resolved = {
  canonical: string;
  preset: FxPreset | null;
  errors: Diagnostic[];
  warnings: Diagnostic[];
};

const byObject = new WeakMap<InlineProgram, Resolved>();
const byHash = new BoundedCache<string, Resolved>(128);

function contentOf(program: InlineProgram): ProgramContent {
  return {
    manifest: program.manifest as unknown as Record<string, unknown>,
    sources: program.sources,
    ...(program.assets != null ? { assets: program.assets } : {}),
  };
}

function isUsableProgram(value: unknown): value is InlineProgram {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const program = value as Partial<InlineProgram>;
  return (
    program.manifest != null &&
    typeof program.manifest === "object" &&
    program.sources != null &&
    typeof program.sources === "object"
  );
}

function resolveProgram(program: InlineProgram): Resolved {
  const known = byObject.get(program);
  if (known != null) {
    return known;
  }

  const canonical = canonicalProgramText(contentOf(program));
  const stored = typeof program.hash === "string" ? program.hash : "";
  const cached = stored === "" ? undefined : byHash.get(stored);
  if (cached != null && cached.canonical === canonical) {
    byObject.set(program, cached);
    return cached;
  }

  // The content decides, not the stored hash. A hand-edited `.ngt` whose hash
  // no longer matches its sources still draws what the sources say.
  const actual = hashProgram(contentOf(program));
  const payload = toRawPayload({ ...program, hash: actual });
  const result = validatePreset(payload);
  const resolved: Resolved = result.ok
    ? {
        canonical,
        preset: result.preset,
        errors: [],
        warnings: (result.warnings ?? []).map((message) =>
          diagnosticOf(message, program.sources),
        ),
      }
    : {
        canonical,
        preset: null,
        errors: result.errors.map((message) =>
          diagnosticOf(message, program.sources),
        ),
        warnings: [],
      };

  byObject.set(program, resolved);
  byHash.set(actual, resolved);
  return resolved;
}

/** What `resolvePreset` reads off an element. */
export type ProgramHolder = {
  presetId: string;
  program?: InlineProgram | null;
};

/**
 * The preset this element draws with, or `null` when there is none to draw.
 *
 * `null` covers an installed preset that is not installed here, an `inline.`
 * id with no program beside it, and a program that does not validate.
 */
export function resolvePreset(element: ProgramHolder | null | undefined): FxPreset | null {
  if (element == null) {
    return null;
  }
  const { program } = element;
  if (program != null) {
    return isUsableProgram(program) ? resolveProgram(program).preset : null;
  }
  if (isInlinePresetId(element.presetId)) {
    return null;
  }
  return typeof element.presetId === "string" ? presetById(element.presetId) : null;
}

/**
 * Why an element's inline program does not draw, and what else its author
 * should know. Empty for an installed preset.
 */
export function inlineDiagnostics(
  element: ProgramHolder | null | undefined,
): { errors: Diagnostic[]; warnings: Diagnostic[] } {
  const program = element?.program;
  if (program == null) {
    if (element != null && isInlinePresetId(element.presetId)) {
      return {
        errors: [{ message: "the clip names an inline program but carries none" }],
        warnings: [],
      };
    }
    return { errors: [], warnings: [] };
  }
  if (!isUsableProgram(program)) {
    return { errors: [{ message: "the stored program is malformed" }], warnings: [] };
  }
  const { errors, warnings } = resolveProgram(program);
  return { errors, warnings };
}

/** Forget every resolved program. For tests. */
export function __clearResolvedProgramsForTesting(): void {
  byHash.clear();
}

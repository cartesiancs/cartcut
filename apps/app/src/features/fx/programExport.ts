/**
 * An element's inline program as the files of a preset folder.
 *
 * Shared by the panel's "Save as preset" and the agent's
 * `save_program_as_preset`, so both write the same folder for the same clip.
 * The id is checked here, against the rules `presetValidate.ts` will apply when
 * the folder is next loaded: a preset that saves and then fails to load is the
 * worst of both.
 */

import {
  isInlinePresetId,
  type InlineProgram,
} from "../../@types/timeline";
import { inlineDiagnostics, resolvePreset } from "./resolvePreset";

export type ProgramFiles = {
  manifestJson: string;
  sources: Record<string, string>;
  /** File name to absolute path, copied in beside the manifest. */
  assets: Record<string, string>;
};

const PRESET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Why `id` cannot name a saved preset, or `null` when it can. */
export function presetIdProblem(id: string): string | null {
  if (!PRESET_ID.test(id) || id.includes("..")) {
    return "Use letters, digits, dots and dashes, like com.me.neon-title.";
  }
  if (isInlinePresetId(id)) {
    return 'A preset id may not start with "inline.".';
  }
  return null;
}

/**
 * A suggested id for a program, from its name. Not guaranteed free: saving
 * over an existing folder of the same id replaces it, as re-importing a LUT does.
 */
export function suggestedPresetId(program: InlineProgram): string {
  const slug = String(program.manifest?.name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return "com.user." + (slug === "" ? program.hash.slice(0, 8) : slug);
}

/** The files to write, or an `Error` that says why this clip cannot be saved. */
export function programFilesFor(
  element: { presetId: string; program?: InlineProgram | null },
  id: string,
): ProgramFiles {
  const program = element.program;
  if (program == null) {
    throw new Error("This clip uses an installed preset, not an inline program.");
  }
  const problem = presetIdProblem(id);
  if (problem != null) {
    throw new Error(problem);
  }
  if (resolvePreset(element) == null) {
    const { errors } = inlineDiagnostics(element);
    throw new Error(
      "The program does not validate, so it would not load as a preset: " +
        errors.map((e) => e.message).join("; "),
    );
  }
  return {
    manifestJson: JSON.stringify({ ...program.manifest, id }, null, 2),
    sources: program.sources,
    assets: program.assets ?? {},
  };
}

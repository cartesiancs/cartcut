/**
 * Inline programs: checking one before it is placed, reading one back, and
 * handing one over to be saved as a preset.
 *
 * Placing a program is not here. It is a `program` field on the commands that
 * already place effects, transitions and graphics, so an agent learns one tool
 * per kind of clip rather than a second set for clips it wrote itself.
 */

import { programFilesFor } from "../../fx/programExport";
import { loadPresets } from "../../fx/presetRegistry";
import { inlineDiagnostics, resolvePreset } from "../../fx/resolvePreset";
import { inlinePresetId } from "../../fx/programHash";
import { currentDoc, requireElement } from "../context";
import { checkProgram } from "../programInput";
import { renderFilmstrip } from "../filmstrip";
import { registerCommands } from "../registry";

/** Default cap on one `get_program` answer, in characters of source. */
const DEFAULT_MAX_CHARS = 20_000;

function requireProgramClip(elementId: string) {
  const element = requireElement(currentDoc(), elementId) as any;
  if (element.program == null) {
    if (element.presetId == null) {
      throw new Error(
        `Clip "${elementId}" is a ${element.filetype} clip, which has no program.`,
      );
    }
    throw new Error(
      `Clip "${elementId}" uses the installed preset "${element.presetId}", not an inline program.`,
    );
  }
  return element;
}

registerCommands({
  /**
   * Validate and compile a program without placing anything.
   *
   * Cheap and side-effect free, so an agent can iterate on a shader here and
   * place it only once it is clean. The answer is the same one `add_effect`
   * would give, because both go through `programInput.checkProgram`.
   */
  check_program: async (params: {
    program: unknown;
    renderAtMs?: number[];
    durationMs?: number;
    box?: { width: number; height: number };
    params?: Record<string, unknown>;
  }) => {
    const checked = checkProgram(params.program);
    const ok = checked.program != null && checked.errors.length === 0;
    const answer: Record<string, unknown> = {
      ok,
      ...(checked.program != null
        ? { presetId: inlinePresetId(checked.program.hash) }
        : {}),
      compiled: checked.compiled,
      errors: checked.errors,
      warnings: checked.warnings,
    };
    const times = (params.renderAtMs ?? []).filter((t) => Number.isFinite(t)).slice(0, 6);
    if (!ok || times.length === 0) {
      return answer;
    }
    if (checked.preset?.kind !== "graphic") {
      return {
        ...answer,
        note: "renderAtMs draws graphics only; an effect or a transition needs the clips beneath it. Place it and use get_contact_sheet.",
      };
    }
    const strip = await renderFilmstrip(checked.program!, checked.preset, {
      times,
      durationMs: params.durationMs,
      box: params.box,
      params: params.params,
    });
    return { ...answer, ...strip };
  },

  /** The program on a clip, with each source capped so one answer stays readable. */
  get_program: (params: { elementId: string; maxChars?: number }) => {
    const element = requireProgramClip(params.elementId);
    const cap = Math.max(200, Math.floor(params.maxChars ?? DEFAULT_MAX_CHARS));
    let budget = cap;
    const sources = Object.keys(element.program.sources)
      .sort()
      .map((name) => {
        const text = String(element.program.sources[name] ?? "");
        const take = Math.max(0, Math.min(text.length, budget));
        budget -= take;
        return {
          name,
          text: text.slice(0, take),
          ...(take < text.length ? { truncated: true, length: text.length } : {}),
        };
      });
    const { errors, warnings } = inlineDiagnostics(element);
    return {
      presetId: element.presetId,
      manifest: element.program.manifest,
      sources,
      ...(element.program.assets != null ? { assets: element.program.assets } : {}),
      draws: resolvePreset(element) != null,
      errors,
      warnings,
    };
  },

  /**
   * A clip's program as the files of a preset folder, under a new id.
   *
   * The second half of `save_program_as_preset`; main writes what this returns.
   * Validated here, against the id it is about to be saved under, so main never
   * writes a folder `loadPresets` would then refuse.
   */
  export_program: (params: { elementId: string; id: string }) =>
    programFilesFor(requireProgramClip(params.elementId), params.id),

  /** Re-read every preset folder, after main has written a new one. */
  reload_presets: async () => {
    await loadPresets();
    return { reloaded: true };
  },
});

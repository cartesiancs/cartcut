/**
 * Programs written on the spot and carried on a clip.
 *
 * An inline program is an installed preset folder without the folder: the same
 * manifest, the same sources, the same `validatePreset`, and `origin: "inline"`
 * as the only difference. So everything that can be said about one can be said
 * about the other, and an inline program can be saved as a preset unchanged.
 *
 * `coerceInlineProgram` is the only constructor. It runs where a program is
 * written (an agent command, the panel) and makes an unusable program
 * unrepresentable from then on; `resolvePreset.ts` is the read side, which must
 * never throw and treats anything it cannot validate as a missing preset.
 *
 * DOM-free and store-free, so it runs under `environment: "node"`.
 */

import type { InlineManifest, InlineProgram } from "../../@types/timeline";
import {
  canonicalProgramText,
  hashProgram,
  inlinePresetId,
  type ProgramContent,
} from "./programHash";
import { validatePreset } from "./presetValidate";
import type { RawPresetPayload } from "./presetTypes";
import { sanitizeProgramSources } from "./programSanitize";

export { canonicalProgramText, hashProgram, inlinePresetId };

/** One thing wrong, or worth knowing, about a program. */
export type Diagnostic = {
  /** The source file it concerns, when it concerns one. */
  file?: string;
  /** 1-based, in the author's own text. */
  line?: number;
  message: string;
};

export type ShaderProgramInput = {
  type: "shader";
  /** The final pass, which defines the entry point for the kind. */
  fragment: string;
  /** Steps run before `fragment`, in order. Effects only. */
  passes?: { fragment: string; constants?: Record<string, number | number[]> }[];
};

export type HtmlProgramInput = {
  type: "html";
  /** A body fragment: no `<html>`, `<head>` or `<body>`. */
  html: string;
  css?: string;
  layout?: "reflow" | "scale";
  designSize?: { width: number; height: number };
  /** Layout px the picture may spill past the box on every side. */
  bleed?: number;
  /** Which parameter receives each field of a text clip converted into this. */
  bindings?: Record<string, string>;
};

/** What an author, human or agent, hands over. */
export type InlineProgramInput = {
  kind: "effect" | "transition" | "graphic";
  name: string;
  /** Defaults per kind; see `DEFAULT_CATEGORY`. */
  category?: string;
  render: ShaderProgramInput | HtmlProgramInput;
  params?: unknown[];
  /** Name a source refers to as `asset:<name>`, to an absolute path. */
  assets?: Record<string, string>;
};

export type CoerceResult =
  | { ok: true; program: InlineProgram; warnings: Diagnostic[] }
  | { ok: false; errors: Diagnostic[] };

/**
 * The category a program lands in when its author names none.
 *
 * Inline programs are not browsed in a grid, so this only has to be a member
 * of the kind's list for `validatePreset` to accept it. Saving the program as a
 * preset is the moment an author should choose properly.
 */
const DEFAULT_CATEGORY: Record<string, string> = {
  effect: "stylize",
  transition: "distort",
  graphic: "kinetic",
  "graphic:shader": "background",
};

/**
 * What an asset may be called: a plain file name with a type the renderer can
 * draw. The name is also what the file is copied to when the program is saved
 * as a preset, so `asset:<name>` means the same thing in both forms.
 */
export const ASSET_NAME =
  /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*\.(png|jpe?g|webp|gif|svg|woff2|ttf|otf)$/i;

/** The fixed filenames an input is unpacked into. */
export const MAIN_FRAGMENT = "main.frag";
export const HTML_SOURCE = "index.html";
export const CSS_SOURCE = "style.css";

export function passFileName(index: number): string {
  return "pass" + index + ".frag";
}

/**
 * Unpack an input into a manifest and its sources, the shape a preset folder
 * has. Filenames are fixed so that two authors writing the same program get
 * byte-identical content, and therefore one hash.
 */
export function programFromInput(input: InlineProgramInput): ProgramContent {
  const sources: Record<string, string> = {};
  let render: Record<string, unknown>;

  if (input.render.type === "shader") {
    const { fragment, passes } = input.render;
    sources[MAIN_FRAGMENT] = fragment;
    const passSpecs = (passes ?? []).map((pass, index) => {
      sources[passFileName(index)] = pass.fragment;
      return {
        source: passFileName(index),
        ...(pass.constants != null ? { constants: pass.constants } : {}),
      };
    });
    render = {
      type: "shader",
      source: MAIN_FRAGMENT,
      ...(passSpecs.length > 0 ? { passes: passSpecs } : {}),
    };
  } else {
    const { html, css, layout, designSize, bleed, bindings } = input.render;
    sources[HTML_SOURCE] = html;
    if (typeof css === "string" && css.trim() !== "") {
      sources[CSS_SOURCE] = css;
    }
    render = {
      type: "html",
      source: HTML_SOURCE,
      ...(sources[CSS_SOURCE] != null ? { styles: [CSS_SOURCE] } : {}),
      ...(layout != null ? { layout } : {}),
      ...(designSize != null ? { designSize } : {}),
      ...(bleed != null && bleed !== 0 ? { bleed } : {}),
      ...(bindings != null && Object.keys(bindings).length > 0
        ? { bindings }
        : {}),
    };
  }

  const categoryKey =
    input.kind === "graphic" && input.render.type === "shader"
      ? "graphic:shader"
      : input.kind;
  const manifest: InlineManifest = {
    schema: 1,
    kind: input.kind,
    name: input.name,
    category: input.category ?? DEFAULT_CATEGORY[categoryKey],
    render,
    ...(input.params != null && input.params.length > 0
      ? { params: input.params }
      : {}),
  };

  const assets =
    input.assets != null && Object.keys(input.assets).length > 0
      ? { ...input.assets }
      : undefined;

  return {
    manifest: manifest as unknown as Record<string, unknown>,
    sources,
    ...(assets != null ? { assets } : {}),
  };
}

/** The payload `validatePreset` takes, as if the program were a folder. */
export function toRawPayload(program: InlineProgram): RawPresetPayload {
  const id = inlinePresetId(program.hash);
  return {
    id,
    dir: "",
    origin: "inline",
    manifestJson: JSON.stringify({ ...program.manifest, id }),
    sources: program.sources,
    assets: program.assets ?? {},
  };
}

/**
 * A validator message as a diagnostic, with the file pulled out when the
 * message starts with one. `validatePreset` writes `main.frag: must define ...`
 * and an agent fixing its program wants to know which file to open.
 */
export function diagnosticOf(
  message: string,
  sources: Record<string, string>,
): Diagnostic {
  const at = message.indexOf(": ");
  if (at > 0) {
    const head = message.slice(0, at);
    if (Object.hasOwnProperty.call(sources, head)) {
      return { file: head, message: message.slice(at + 2) };
    }
  }
  return { message };
}

function structuralErrors(input: unknown): Diagnostic[] {
  const errors: Diagnostic[] = [];
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return [{ message: "program: must be an object" }];
  }
  const raw = input as Record<string, unknown>;
  if (!["effect", "transition", "graphic"].includes(raw.kind as string)) {
    errors.push({ message: "kind: must be effect, transition or graphic" });
  }
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    errors.push({ message: "name: must be a non-empty string" });
  }
  if (raw.category != null && typeof raw.category !== "string") {
    errors.push({ message: "category: must be a string" });
  }
  const render = raw.render as Record<string, unknown> | undefined;
  if (render == null || typeof render !== "object") {
    errors.push({ message: "render: must be an object" });
  } else if (render.type === "shader") {
    if (typeof render.fragment !== "string" || render.fragment.trim() === "") {
      errors.push({ message: "render.fragment: must be GLSL source" });
    }
    if (render.passes != null) {
      if (!Array.isArray(render.passes)) {
        errors.push({ message: "render.passes: must be an array" });
      } else {
        render.passes.forEach((pass, index) => {
          if (
            pass == null ||
            typeof pass !== "object" ||
            typeof (pass as { fragment?: unknown }).fragment !== "string"
          ) {
            errors.push({
              message: "render.passes[" + index + "].fragment: must be GLSL source",
            });
          }
        });
      }
    }
  } else if (render.type === "html") {
    if (typeof render.html !== "string") {
      errors.push({ message: "render.html: must be a string" });
    }
    if (render.css != null && typeof render.css !== "string") {
      errors.push({ message: "render.css: must be a string" });
    }
  } else {
    errors.push({ message: "render.type: must be shader or html" });
  }
  if (raw.params != null && !Array.isArray(raw.params)) {
    errors.push({ message: "params: must be an array" });
  }
  if (raw.assets != null) {
    const assets = raw.assets as Record<string, unknown>;
    if (typeof assets !== "object" || Array.isArray(assets)) {
      errors.push({ message: "assets: must be an object of name to path" });
    } else {
      for (const [name, path] of Object.entries(assets)) {
        if (!ASSET_NAME.test(name)) {
          errors.push({
            message:
              "assets." +
              name +
              ": must be a file name with its extension, like photo.png or brand.woff2",
          });
        }
        if (typeof path !== "string" || path === "") {
          errors.push({ message: "assets." + name + ": must be an absolute path" });
        }
      }
    }
  }
  return errors;
}

/**
 * Validate an input and turn it into the stored form, or say why not.
 *
 * HTML sources are sanitised before hashing, so what is stored and hashed is
 * what will be mounted: two authors whose markup differs only in something the
 * sanitiser removes end up with one program, and the removals come back as
 * warnings an agent can act on.
 */
export function coerceInlineProgram(input: unknown): CoerceResult {
  const structural = structuralErrors(input);
  if (structural.length > 0) {
    return { ok: false, errors: structural };
  }

  const content = programFromInput(input as InlineProgramInput);
  const sanitized = sanitizeProgramSources(content);
  const unhashed = sanitized.content;

  const program: InlineProgram = {
    hash: hashProgram(unhashed),
    manifest: unhashed.manifest as unknown as InlineManifest,
    sources: unhashed.sources,
    ...(unhashed.assets != null ? { assets: unhashed.assets } : {}),
  };

  const result = validatePreset(toRawPayload(program));
  if (!result.ok) {
    return {
      ok: false,
      errors: result.errors.map((message) =>
        diagnosticOf(message, program.sources),
      ),
    };
  }
  return {
    ok: true,
    program,
    warnings: [
      ...sanitized.warnings,
      ...(result.warnings ?? []).map((message) =>
        diagnosticOf(message, program.sources),
      ),
    ],
  };
}

/** Whether two stored programs are the same program, whatever their hashes claim. */
export function sameProgram(
  a: InlineProgram | null | undefined,
  b: InlineProgram | null | undefined,
): boolean {
  if (a == null || b == null) {
    return a == null && b == null;
  }
  if (a === b) {
    return true;
  }
  return canonicalProgramText(a as unknown as ProgramContent) ===
    canonicalProgramText(b as unknown as ProgramContent);
}

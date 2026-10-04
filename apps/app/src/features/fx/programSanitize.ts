/**
 * Making a program's sources safe to store, before they are hashed.
 *
 * GLSL needs nothing: it has no I/O, and the compiler is the boundary. HTML and
 * CSS go through `graphic/sanitizeHtml.ts` and `graphic/cssFilter.ts`, and what
 * is stored is what they let through, re-serialised. So the hash names the
 * content that will actually mount, two drafts that differ only in something
 * the sanitiser removes are one program, and every removal comes back to the
 * author as a warning.
 *
 * The read side sanitises again (`graphic/mountSpec.ts`): a hand-edited `.ngt`
 * or a downloaded preset never passed through here.
 */

import type { Diagnostic } from "./inlineProgram";
import type { ProgramContent } from "./programHash";
import { filterStylesheet } from "../graphic/cssFilter";
import { sanitizeHtml, serializeSafeNodes } from "../graphic/sanitizeHtml";

export type SanitizedProgram = {
  content: ProgramContent;
  /** What was removed, and why, for the author. */
  warnings: Diagnostic[];
};

export function sanitizeProgramSources(content: ProgramContent): SanitizedProgram {
  const render = content.manifest.render as
    | { type?: unknown; source?: unknown; styles?: unknown }
    | undefined;
  if (render?.type !== "html") {
    return { content, warnings: [] };
  }
  const assetNames = new Set(Object.keys(content.assets ?? {}));
  const sources = { ...content.sources };
  const warnings: Diagnostic[] = [];

  if (typeof render.source === "string" && typeof sources[render.source] === "string") {
    const result = sanitizeHtml(sources[render.source], { assetNames, file: render.source });
    sources[render.source] = serializeSafeNodes(result.nodes);
    warnings.push(...result.removed);
  }
  for (const sheet of Array.isArray(render.styles) ? render.styles : []) {
    if (typeof sheet !== "string" || typeof sources[sheet] !== "string") {
      continue;
    }
    const result = filterStylesheet(sources[sheet], { assetNames, file: sheet });
    // The `@property` rules first, where an author would write them; the host
    // lifts them back out and registers them at document level.
    sources[sheet] = [result.propertyRules.trim(), result.css.trim()].filter(Boolean).join("\n");
    warnings.push(...result.removed);
  }
  return { content: { ...content, sources }, warnings };
}

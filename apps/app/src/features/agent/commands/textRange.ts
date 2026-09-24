/**
 * Naming a stretch of a text clip from outside the editor.
 *
 * **Offsets are UTF-16 code units, and that is a trap rather than a choice.**
 * A run's `from`/`to` are measured the way `textarea.selectionStart` measures,
 * because that is where the panel's values come from. An agent counting those
 * by hand over a string with an emoji or a combining mark in it gets them
 * wrong, and the failure is silent — the range lands somewhere, just not where
 * it was meant to. So a range may also be given as `match`, a substring, and
 * the offsets are found here.
 *
 * `match` with no `occurrence` names **every** occurrence. That is what a
 * find-and-replace does, it is what "make every mention of the product name
 * bold" means, and the alternative default — the first one only — is the one
 * that looks like it worked.
 *
 * A `match` that is not in the text is **refused**, not skipped. Skipping is
 * indistinguishable from success to the caller, and the usual cause is a typo
 * or a case difference the caller can fix once told. One bad entry refuses the
 * whole list for the same reason `add_keyframes` validates every time before
 * writing any: half an edit is worse than none.
 *
 * Shared by `textRuns.ts`, which styles a range, and by `measure_text`, which
 * measures one. Pure and string-only, so it runs under `environment: "node"`.
 */

import {
  isRunStylable,
  RUN_STYLABLE_FILETYPES,
} from "../../timeline/textRunOps";
import type { TimelineDocument } from "../../timeline/tracks";
import { requireElement } from "../context";

/** How a caller names a stretch of the text. */
export type RangeSpec = {
  from?: number;
  to?: number;
  match?: string;
  occurrence?: number;
};

/** A resolved half-open `[from, to)` in UTF-16 code units. */
export type Range = { from: number; to: number };

/**
 * The text clip behind an id, or a refusal naming what it actually is.
 *
 * Separate from `requireElement` because the message is the useful part: an
 * agent that reached for this on a shape has misread which clip it selected,
 * and "shape" in the answer is what tells it so.
 */
export function requireTextElement(doc: TimelineDocument, elementId: string) {
  const element = requireElement(doc, elementId);
  if (!isRunStylable(element)) {
    throw new Error(
      `Only ${RUN_STYLABLE_FILETYPES.join(", ")} clips carry per-range style; ` +
        `${elementId} is a ${element.filetype} clip.`,
    );
  }
  return element;
}

/** Every start offset of `needle` in `haystack`, left to right, non-overlapping. */
export function occurrencesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    out.push(at);
    at = haystack.indexOf(needle, at + needle.length);
  }
  return out;
}

/**
 * One spec to the ranges it names.
 *
 * Throws rather than returning an empty list for anything the caller can fix:
 * a `match` that is absent, an `occurrence` past the end, a spec that names
 * neither form. A range that is merely empty after clamping is left to
 * `editRunStyle`, which declines by identity — that is a no-op edit, not a bad
 * request.
 */
export function resolveRange(text: string, spec: RangeSpec, index: number): Range[] {
  const where = `ranges[${index}]`;

  if (typeof spec?.match === "string" && spec.match !== "") {
    const starts = occurrencesOf(text, spec.match);
    if (starts.length === 0) {
      throw new Error(
        `${where}: ${JSON.stringify(spec.match)} does not appear in the clip's text. ` +
          `The match is exact and case-sensitive; get_clip shows the text.`,
      );
    }

    if (spec.occurrence == null) {
      return starts.map((from) => ({ from, to: from + spec.match!.length }));
    }

    const nth = Math.floor(spec.occurrence);
    if (nth < 1 || nth > starts.length) {
      throw new Error(
        `${where}: ${JSON.stringify(spec.match)} appears ${starts.length} time(s), ` +
          `so occurrence ${spec.occurrence} does not exist. Occurrences are 1-based; ` +
          `omit it to style every one.`,
      );
    }
    return [{ from: starts[nth - 1], to: starts[nth - 1] + spec.match.length }];
  }

  if (typeof spec?.from === "number" && typeof spec?.to === "number") {
    return [{ from: spec.from, to: spec.to }];
  }

  throw new Error(
    `${where} needs either \`match\` (a substring) or both \`from\` and \`to\` ` +
      `(UTF-16 code unit offsets). Prefer \`match\`: offsets are easy to miscount.`,
  );
}

/** Every range named by the whole list, in the order the caller wrote them. */
export function resolveRanges(text: string, specs: RangeSpec[] | undefined): Range[] {
  const list = specs ?? [];
  if (list.length === 0) {
    throw new Error("`ranges` needs at least one entry.");
  }
  return list.flatMap((spec, index) => resolveRange(text, spec, index));
}

/**
 * Document-level edits to a text clip's per-range style.
 *
 * The three rules `blendOps.ts` states hold here too: only a text clip can
 * carry runs, the default deletes the key rather than storing it, and declining
 * returns the document by identity so `withCheckpoint` records no undo step.
 *
 * One rule is this module's own, and it is what makes the second of those true
 * for a *sparse* field. **A patch field equal to the clip's own value is
 * dropped before it is written.** Painting a range the colour it already is
 * therefore produces an empty style, which `applyRunStyle` drops, which leaves
 * no runs, which deletes the field. Without it "select all, pick the same
 * colour" would store a run that changes nothing and a project saved after the
 * feature would differ from the same project saved before it.
 *
 * Validation is not here. `text/runs.ts#coerceRunStyle` runs at the panel
 * boundary, which is the only place a bad value can be reported usefully, and
 * again inside `applyRunStyle` so nothing outside the vocabulary can reach the
 * document from either direction.
 */

import type {
  TextElementType,
  TextRun,
  TextRunStyle,
  TimelineElement,
} from "../../@types/timeline";
import {
  applyRunStyle,
  clearRunStyle,
  diffEdit,
  elementRunStyle,
  runsOf,
  sameRuns,
  shiftRuns,
  type RunStyleKey,
} from "../text/runs";
import type { TimelineDocument } from "./tracks";

/**
 * The element types that can carry runs.
 *
 * One member, and still a list: the agent command and the panel both name it in
 * their refusals, and a second member (a caption-only variant, say) would
 * otherwise be a search through every `filetype === "text"` in the tree.
 */
export const RUN_STYLABLE_FILETYPES = ["text"] as const;

const RUN_STYLABLE = new Set<string>(RUN_STYLABLE_FILETYPES);

/** Whether a range style can be set on this element. */
export function isRunStylable(
  element: TimelineElement | undefined | null,
): element is TextElementType {
  return element != null && RUN_STYLABLE.has(element.filetype);
}

/**
 * A run list nothing else holds a reference to.
 *
 * `pasteClips` and `splitAt` spread the element, so a clip and its copy share
 * one `runs` array until somebody writes. Allocating here is what makes "the
 * document is immutable by convention" true for this field rather than merely
 * intended, and it is cheap: the list has one entry per visibly distinct
 * stretch, not per edit.
 */
function copyRuns(runs: readonly TextRun[]): TextRun[] {
  return runs.map((run) => ({
    from: run.from,
    to: run.to,
    style: { ...run.style },
  }));
}

/**
 * The element with `next` on it, or with the field gone.
 *
 * The single write path. Every op below funnels through it so that the decline
 * and the key deletion are decided in one place.
 */
function withRuns(
  doc: TimelineDocument,
  elementId: string,
  next: readonly TextRun[],
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isRunStylable(element)) {
    return doc;
  }
  if (sameRuns(runsOf(element), next)) {
    return doc;
  }

  const source = element as TimelineElement & { runs?: TextRun[] };

  let updated: TimelineElement;
  if (next.length === 0) {
    // Removed, not set to `undefined`. `JSON.stringify` drops an undefined and
    // `structuredClone`, which the copy path uses, keeps it, so a stored
    // `undefined` would make the saved project and the one in memory disagree
    // about whether the clip had ever been styled. `maskOps.ts` says the same.
    const { runs: _cleared, ...rest } = source;
    updated = rest as TimelineElement;
  } else {
    updated = { ...source, runs: copyRuns(next) } as TimelineElement;
  }

  return { ...doc, elements: { ...doc.elements, [elementId]: updated } };
}

/**
 * Drop the patch fields the clip already has.
 *
 * This is the rule in the module header. It runs before the write rather than
 * after it, because a run whose style is empty is never built at all and so can
 * never be stored.
 */
function overridesOnly(
  element: TextElementType,
  patch: TextRunStyle,
): TextRunStyle {
  const own = elementRunStyle(element);
  const out: TextRunStyle = {};
  for (const key of Object.keys(patch) as RunStyleKey[]) {
    const value = patch[key];
    if (value !== undefined && value !== own[key]) {
      (out[key] as unknown) = value;
    }
  }
  return out;
}

/**
 * Merge a style patch over `[from, to)` of one clip's text.
 *
 * Declines by identity for a clip that is not text, a range that covers
 * nothing, a patch with nothing readable in it, and a patch already in force.
 */
export function setTextRangeStyle(
  doc: TimelineDocument,
  elementId: string,
  from: number,
  to: number,
  patch: TextRunStyle,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isRunStylable(element)) {
    return doc;
  }
  const overrides = overridesOnly(element, patch);

  // Nothing but the clip's own values: the *range* still has to be cleared,
  // because a run there may be saying something else. Asking for white on a
  // range somebody made red is a request to remove the run, not a no-op.
  const next =
    Object.keys(overrides).length === 0
      ? clearRunStyle(runsOf(element), from, to, element.text ?? "")
      : applyRunStyle(
          runsOf(element),
          from,
          to,
          overrides,
          element.text ?? "",
        );

  return withRuns(doc, elementId, next);
}

/** The same write across several clips, as one undo step. */
export function setTextRangeStyleMany(
  doc: TimelineDocument,
  elementIds: readonly string[],
  from: number,
  to: number,
  patch: TextRunStyle,
): TimelineDocument {
  return elementIds.reduce(
    (next, elementId) => setTextRangeStyle(next, elementId, from, to, patch),
    doc,
  );
}

/** Drop every override over `[from, to)`, whatever it said. */
export function clearTextRangeStyle(
  doc: TimelineDocument,
  elementId: string,
  from: number,
  to: number,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isRunStylable(element)) {
    return doc;
  }
  return withRuns(
    doc,
    elementId,
    clearRunStyle(runsOf(element), from, to, element.text ?? ""),
  );
}

/** Take the clip back to one style everywhere. */
export function clearTextRuns(
  doc: TimelineDocument,
  elementId: string,
): TimelineDocument {
  return withRuns(doc, elementId, []);
}

/**
 * Replace a clip's string, carrying the runs across the edit.
 *
 * The text and the runs are written **together**, in one document, because the
 * two are one fact: a run list that has not followed the edit points at the
 * wrong characters, and every frame drawn between two writes would show it.
 * `elementControl.ts#changeTextValue` routes through here, so the panel's
 * commit, the agent's `update_clip` and the caption session all follow the edit
 * without knowing this feature exists.
 */
export function setTextWithRuns(
  doc: TimelineDocument,
  elementId: string,
  nextText: string,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isRunStylable(element)) {
    return doc;
  }

  const before = element.text ?? "";
  const edit = diffEdit(before, nextText);
  if (edit == null) {
    return doc;
  }

  const runs = runsOf(element);
  const shifted = shiftRuns(runs, edit);

  const updated = { ...element, text: nextText } as TimelineElement & {
    runs?: TextRun[];
  };
  if (shifted.length === 0) {
    delete updated.runs;
  } else {
    updated.runs = copyRuns(shifted);
  }

  return {
    ...doc,
    elements: { ...doc.elements, [elementId]: updated as TimelineElement },
  };
}

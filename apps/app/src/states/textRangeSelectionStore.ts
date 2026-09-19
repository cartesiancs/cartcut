import { createStore } from "zustand/vanilla";

/**
 * Which characters of a text clip the user currently has selected in the
 * option panel's text field.
 *
 * ## It is not a field on the element, and that is the decision
 *
 * `TextElementType` would take a `selection?: { from, to }` happily.
 * `timeline.json` is a bare `JSON.stringify` of the element map, an optional
 * field never moves `SCHEMA_VERSION`, and undo would cover it for free.
 *
 * It is still wrong, because a selection is not a property of the clip. It is
 * another name for "where the caret is right now". Written into the document it
 * would be saved, undone, and restored onto a project whose panel is not even
 * open - a highlight with nobody holding it, which is exactly what
 * `timelineLockStore` argues a lock must never be. Keeping it here makes that
 * unrepresentable: nothing saves it and a reload has none.
 *
 * The preview is the only reader. `previewCanvas` draws the wash in its chrome
 * pass, after the composite, so it never reaches an export.
 */
export interface ITextRangeSelectionStore {
  /** The live range, or null for a collapsed caret and for no panel at all. */
  range: { elementId: string; from: number; to: number } | null;
  select: (elementId: string, from: number, to: number) => void;
  clear: () => void;
}

export const textRangeSelectionStore = createStore<ITextRangeSelectionStore>(
  (set, get) => ({
    range: null,

    /**
     * Guarded before `set`, the rule `selectionStore` and `timelineLockStore`
     * both state: zustand merges a partial into a fresh object and notifies
     * whether or not anything changed. This is written from the field's
     * `select` event, which fires on every pointermove of a drag and mostly
     * names the range already held, so without the guard the preview would
     * repaint dozens of times a second for nothing.
     *
     * A collapsed caret stores `null` rather than a zero-width range. The
     * panel's controls read "is there a range" from this, and a caret means
     * "apply to the whole clip" - the behaviour the app had before runs
     * existed.
     */
    select: (elementId, from, to) => {
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      if (lo >= hi) {
        get().clear();
        return;
      }

      const current = get().range;
      if (
        current != null &&
        current.elementId === elementId &&
        current.from === lo &&
        current.to === hi
      ) {
        return;
      }
      set({ range: { elementId, from: lo, to: hi } });
    },

    clear: () => {
      if (get().range === null) {
        return;
      }
      set({ range: null });
    },
  }),
);

/** The live range on one clip, or null when the selection is elsewhere. */
export function textRangeFor(
  elementId: string | undefined,
): { from: number; to: number } | null {
  const range = textRangeSelectionStore.getState().range;
  if (range == null || elementId == null || range.elementId !== elementId) {
    return null;
  }
  return { from: range.from, to: range.to };
}

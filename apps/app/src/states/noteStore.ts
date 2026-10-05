/**
 * The timeline's notes, and which one has its card open.
 *
 * A store of its own and not a field on `TimelineDocument`, for the reasons
 * `features/note/notes.ts` gives. `notes` is what the project holds; `open` is
 * where the card is and is never saved. Auto Save and the dirty digest read
 * `notes` only.
 *
 * Every write that changes nothing returns `state` by identity, so zustand
 * notifies nobody, as in `trackHeightStore`.
 */

import { createStore } from "zustand/vanilla";

import {
  NO_NOTES,
  coerceNoteText,
  type TimelineNote,
} from "../features/note/notes";

export type OpenNote = {
  id: string;
  /** Where the card hangs, in viewport px. */
  x: number;
  y: number;
};

export interface INoteStore {
  notes: readonly TimelineNote[];
  open: OpenNote | null;

  add: (note: TimelineNote) => void;
  /** Keep `text` on a note. Text that is empty once trimmed removes the note. */
  setText: (id: string, text: string) => void;
  remove: (id: string) => void;
  openAt: (id: string, x: number, y: number) => void;
  close: () => void;
  /** Load: replaces everything, for a project that was just opened. */
  replace: (notes: readonly TimelineNote[]) => void;
}

export const noteStore = createStore<INoteStore>((set) => ({
  notes: NO_NOTES,
  open: null,

  add: (note) =>
    set((state) => ({ ...state, notes: [...state.notes, note] })),

  setText: (id, text) =>
    set((state) => {
      const kept = coerceNoteText(text);
      const note = state.notes.find((each) => each.id === id);
      if (note == null || note.text === kept) {
        return state;
      }
      if (kept === "") {
        return withoutNote(state, id);
      }
      return {
        ...state,
        notes: state.notes.map((each) =>
          each.id === id ? { ...each, text: kept } : each,
        ),
      };
    }),

  remove: (id) => set((state) => withoutNote(state, id)),

  openAt: (id, x, y) =>
    set((state) =>
      state.open?.id === id && state.open.x === x && state.open.y === y
        ? state
        : { ...state, open: { id, x, y } },
    ),

  close: () => set((state) => (state.open == null ? state : { ...state, open: null })),

  replace: (notes) =>
    set((state) => {
      if (
        state.open == null &&
        JSON.stringify(state.notes) === JSON.stringify(notes)
      ) {
        return state;
      }
      return { ...state, notes, open: null };
    }),
}));

function withoutNote(state: INoteStore, id: string): INoteStore {
  if (!state.notes.some((note) => note.id === id)) {
    return state;
  }
  return {
    ...state,
    notes: state.notes.filter((note) => note.id !== id),
    open: state.open?.id === id ? null : state.open,
  };
}
